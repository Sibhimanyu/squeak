import Foundation
import Observation
import SqueakMacCore

// Small observable stores for the state that changes most often. AppModel forwards to them with computed
// properties, so a view that reads `model.awake` registers only the store's `awake`, and a poll that publishes it
// never re-evaluates the sidebar. Every forwarding setter is change-guarded.

/// Awake, power, heat and hotspot: the daemon's report, read every 20 s. Held apart from AppModel so a reading never wakes the sidebar or the workbench.
@MainActor @Observable
final class AwakeStore {
    var awake: DaemonAwake?
    var awakeOffered: Bool = false
    var awakeLidReady: Bool = false
    var settingUpLid: Bool = false
    var settingUpFans: Bool = false
    var settingUpPower: Bool = false
    var settingPowerMode: Bool = false
    var powerModeNote: String?
    var power: DaemonPower?
    var heat: DaemonHeat?
    var hotspot: DaemonHotspot?
    var awakeLidActions: DaemonLidActions?
    var awakeOpenActions: DaemonOpenActions?
    var awakeLidClosedNow: Bool = false
    var awakeLastEnd: DaemonAwakeEnd?
    var awakeSleepProblem: String?
    var awakeRules: DaemonAwakeRules?
    var hotspotNote: String?
    var savingHotspot: Bool = false
    var awakeNote: String?
}

/// Usage and Claude accounts: read while a usage view is on screen.
@MainActor @Observable
final class UsageStore {
    var usage: UsageSnapshot?
    var claudeRefreshing: Bool = false
    var claudeRefreshNote: String?
    var claudeAccounts: ClaudeAccountList?
    var claudeSwitching: Bool = false
    var claudeAccountNote: String?
}

/// The open chat's transcript, paging, steps and extras, and the rows' live phrases: what changes every poll while a chat works.
@MainActor @Observable
final class OpenChatStore {
    var messages: [ChatMessage] = []
    var paging: EarlierPaging = EarlierPaging()
    var activity: [ActivityStep] = []
    var chatExtras: ChatExtras?
    var liveSteps: [SessionKey: String] = [:]
}

/// Every value AppModel derives from its sessions, each computed once per change of its inputs.
@MainActor
final class DerivedSessions {
    struct Row<T> { var session: HostSession; var value: T }
    let tree = Memo<SidebarTree>()
    let visible = Memo<[HostSession]>()
    let ordered = Memo<OrderedSessions>()
    let providers = Memo<[String]>()
    let repos = Memo<[String]>()
    let attention = Memo<Int>()
    let hasCodex = Memo<Bool>()
    let counts = KeyedMemo<NavFilter, Int>()
    let search = KeyedMemo<String, [SearchHit]>()
    let titles = KeyedMemo<SessionKey, Row<String>>()
    let marks = KeyedMemo<SessionKey, Row<ChatMark?>>()
    let labels = KeyedMemo<SessionKey, Row<String>>()

    func invalidateAll() {
        tree.invalidate(); visible.invalidate(); ordered.invalidate(); providers.invalidate(); repos.invalidate()
        attention.invalidate(); hasCodex.invalidate(); counts.invalidate(); search.invalidate()
        titles.invalidate(); marks.invalidate(); labels.invalidate()
    }

    /// A transcript was loaded: its text feeds search and the fallback title of that chat.
    func messagesChanged(_ key: SessionKey) {
        search.invalidate(); titles.invalidate(key); labels.invalidate(key)
    }
}
