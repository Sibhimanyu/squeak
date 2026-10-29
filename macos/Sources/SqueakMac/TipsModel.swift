import AppKit
import CoreGraphics
import Foundation
import Observation
import SqueakMacCore

/// The after-setup tip in the menu-bar panel. `TipHistory` (SqueakMacCore) decides which tip shows, when and
/// for how long it rests; this gathers the facts, keeps the history on disk and opens the destination.
@MainActor @Observable
final class TipsModel {
    /// The tip on screen, or nil.
    private(set) var tip: Tip?
    @ObservationIgnored private var history: TipHistory
    @ObservationIgnored private var waits = QuestionWaitTracker()
    @ObservationIgnored private let demo: Bool
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private var lastChannelsRead = Date.distantPast
    @ObservationIgnored private var lastGrantsRead = Date.distantPast
    @ObservationIgnored private var hands: HandsGrants?
    private static let key = "setupTipsHistory"

    init(demo: Bool) {
        self.demo = demo
        if !demo, let data = UserDefaults.standard.data(forKey: Self.key),
           let saved = try? JSONDecoder().decode(TipHistory.self, from: data) {
            history = saved
        } else {
            history = TipHistory()
        }
    }

    private func save() {
        guard !demo, let data = try? JSONEncoder().encode(history) else { return }
        defaults.set(data, forKey: Self.key)
    }

    // MARK: Events

    func note(_ signal: ReplyGrantSignal) {
        switch signal {
        case .accessibility: history.noteBackgroundFallbackForAccessibility(at: Date())
        case .terminalAutomation: history.noteTerminalAutomationFailure(at: Date())
        }
        save()
    }

    func noteComposerUse() {
        history.noteComposerUse()
        save()
    }

    func dismiss(forever: Bool) {
        guard let tip else { return }
        history.dismiss(tip, forever: forever, now: Date())
        self.tip = nil
        save()
    }

    /// The tip's own button: it rests for 14 days, then opens its destination.
    func open(_ model: AppModel) {
        guard let tip else { return }
        history.opened(tip, now: Date())
        self.tip = nil
        save()
        model.dismissMenuBar?()
        switch tip.destination {
        case .permission(let kind): model.openPermission(kind)
        case .settings(let section): model.openSettings(section)
        }
    }

    // MARK: Reading

    /// Called every few seconds with the app's own state, and when the panel opens.
    func refresh(_ model: AppModel) async {
        guard !demo, !model.captureMode else { return }
        let now = Date()
        // The channel, voice and notification readings are one call each; once a minute is plenty.
        if now.timeIntervalSince(lastChannelsRead) > 60 {
            lastChannelsRead = now
            await model.channels.refresh()
        }
        let c = model.channels
        var ids = Set(c.remote?.activeDevices.map(\.id) ?? [])
        if c.channels?.telegram.configured == true { ids.insert("telegram") }
        if c.channels?.cliq.oneWay == true || c.channels?.cliq.twoWay == true { ids.insert("cliq") }
        // Not read yet (a daemon that is off): leave what was known, so a restart is not a new pairing.
        if c.channels != nil { history.observeChannels(ids, now: now) }

        let asking = Set(model.sessions.filter { $0.pendingQuestion != nil || ($0.state == .blocked && $0.awaitingApproval != true) }
            .map(\.key.stringValue))
        waits.observe(waiting: asking, now: now)

        // Squeak Hands is asked only once a reply has shown it may lack a grant, and at most once a minute.
        let needsHands = history.accessibilityFallbackAt != nil || history.terminalAutomationFailedAt != nil
        if needsHands, now.timeIntervalSince(lastGrantsRead) > 60 {
            lastGrantsRead = now
            hands = await model.client.handsGrants()
        }
        let readHands = hands.flatMap { $0.outdated ? nil : $0 }

        let facts = TipFacts(
            firstRunActive: OnboardingController.shared.isShowing || (model.setup.progress.started && !model.setup.progress.finished),
            channelIDs: ids,
            phoneOrTelegramSetUp: !(c.remote?.activeDevices.isEmpty ?? true) || c.channels?.telegram.configured == true,
            awakeSetUp: model.awake != nil || model.awakeLidReady,
            accessibilityGranted: readHands?.accessibility,
            automationGranted: readHands.map { $0.automationTerminal == "granted" },
            inputMonitoringGranted: CGPreflightListenEventAccess(),
            voiceSetUp: c.voice.map { $0.isOn && $0.callee != nil } ?? false,
            longestQuestionWait: waits.longest(now: now),
            cardsPushedToday: c.notify?.mostPushedToday ?? 0)
        let next = history.tipToShow(facts: facts, now: now)
        if next != tip { tip = next }
        save()
    }
}
