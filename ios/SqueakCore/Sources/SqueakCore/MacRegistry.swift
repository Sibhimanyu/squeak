import Foundation

/// One Mac this iPhone can open: the pairing (it carries the channel key), the device id the Mac registered this
/// phone's key under, and what the phone last knew of it. The device key is shared by all of them (it is the phone's,
/// not the Mac's); each Mac keeps its own record of it, so one Mac removing this iPhone leaves the others alone.
public struct MacEntry: Codable, Equatable, Identifiable, Sendable {
    /// The Mac's id in the account's list: its channel id (`pairing.c`).
    public var macId: String
    public var name: String
    public var pairing: PairingPayload
    public var deviceId: String
    /// False only for a QR pairing the Mac has not answered yet (the fallback path).
    public var approved: Bool
    /// Names this Mac's cache files (`squeak-snapshot-<key>.json`, ...). Nil for the Mac that was on the phone before
    /// there could be several: it keeps the original file names, so nothing is moved.
    public var cacheKey: String?
    /// When the Mac last answered this phone.
    public var lastSeen: Date?

    public var id: String { macId }

    public init(pairing: PairingPayload, deviceId: String, approved: Bool, cacheKey: String? = nil, lastSeen: Date? = nil) {
        self.macId = pairing.c
        self.name = pairing.n
        self.pairing = pairing
        self.deviceId = deviceId
        self.approved = approved
        self.cacheKey = cacheKey ?? Self.cacheKey(for: pairing.c)
        self.lastSeen = lastSeen
    }

    /// File-name-safe and stable: channel ids are URL-safe base64.
    public static func cacheKey(for macId: String) -> String {
        String(macId.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }.prefix(16))
    }
}

/// Every Mac this phone holds, and which one is open. A pure value: the Keychain lives in `MacRegistryStore`.
public struct MacRegistry: Codable, Equatable, Sendable {
    public private(set) var v = 1
    public private(set) var entries: [MacEntry] = []
    public private(set) var activeId: String?

    public init() {}

    public var active: MacEntry? { activeId.flatMap(entry(for:)) }
    public func entry(for macId: String) -> MacEntry? { entries.first { $0.macId == macId } }
    public var isEmpty: Bool { entries.isEmpty }

    /// Adds `entry`, or replaces the one for the same Mac (keeping its cache). Opens it when asked or when it is the first.
    public mutating func upsert(_ entry: MacEntry, makeActive: Bool = true) {
        var entry = entry
        if let i = entries.firstIndex(where: { $0.macId == entry.macId }) {
            entry.cacheKey = entries[i].cacheKey
            entry.lastSeen = entry.lastSeen ?? entries[i].lastSeen
            entries[i] = entry
        } else {
            entries.append(entry)
        }
        if makeActive || activeId == nil { activeId = entry.macId }
    }

    /// Opens another held Mac. False (and nothing changes) for one this phone does not hold.
    @discardableResult
    public mutating func activate(_ macId: String) -> Bool {
        guard entry(for: macId) != nil else { return false }
        activeId = macId
        return true
    }

    /// Forgets one Mac. When it was open, the first remaining one opens (nil when none is left).
    public mutating func remove(_ macId: String) {
        entries.removeAll { $0.macId == macId }
        if activeId == macId { activeId = entries.first?.macId }
    }

    public mutating func update(_ macId: String, _ change: (inout MacEntry) -> Void) {
        guard let i = entries.firstIndex(where: { $0.macId == macId }) else { return }
        change(&entries[i])
    }
}

/// Where the secrets live; the app's Keychain, or a dictionary in tests.
public protocol SecretStore: AnyObject {
    func load(account: String) -> Data?
    func save(_ data: Data, account: String)
    func delete(account: String)
}

/// The list of Macs in one Keychain item (`macs`), replacing the single `pairing` item older versions kept.
public final class MacRegistryStore {
    public static let account = "macs"
    /// The three items a single-Mac phone kept.
    public static let legacyAccounts = ["pairing", "device-id", "approved"]

    private let secrets: SecretStore

    public init(secrets: SecretStore) { self.secrets = secrets }

    /// The saved list. A phone that still has the old single pairing gets it as the first (and open) Mac, once: the
    /// new item is written before the old ones are deleted, so a crash between the two loses nothing.
    public func load() -> MacRegistry {
        if let data = secrets.load(account: Self.account) {
            if let registry = try? JSONDecoder().decode(MacRegistry.self, from: data) { return registry }
            // An unreadable list is left alone (never overwritten by a migration); the phone starts empty.
            return MacRegistry()
        }
        guard let legacy = migrated() else { return MacRegistry() }
        save(legacy)
        for account in Self.legacyAccounts { secrets.delete(account: account) }
        return legacy
    }

    private func migrated() -> MacRegistry? {
        guard let data = secrets.load(account: "pairing"),
              let pairing = try? JSONDecoder().decode(PairingPayload.self, from: data),
              let deviceId = secrets.load(account: "device-id").flatMap({ String(data: $0, encoding: .utf8) }), !deviceId.isEmpty
        else { return nil }
        var registry = MacRegistry()
        var entry = MacEntry(pairing: pairing, deviceId: deviceId, approved: secrets.load(account: "approved") != nil)
        entry.cacheKey = nil   // the original, unsuffixed cache files
        registry.upsert(entry)
        return registry
    }

    public func save(_ registry: MacRegistry) {
        guard let data = try? JSONEncoder().encode(registry) else { return }
        secrets.save(data, account: Self.account)
    }

    /// Every Mac forgotten (sign out, or the last removal).
    public func wipe() {
        secrets.delete(account: Self.account)
        for account in Self.legacyAccounts { secrets.delete(account: account) }
    }
}

/// Whether a Mac is there to talk to, as the list words it.
public enum MacPresence: Equatable, Sendable {
    case online
    /// Stopped answering a little while ago: usually asleep, and it comes back by itself.
    case asleep(since: Date?)
    case offline(since: Date?)
    /// Never heard from by this phone.
    case unknown

    /// A Mac that answered in the last 90 s is online; one that went quiet less than a day ago is asleep (a closed lid
    /// is the usual reason); longer is offline. `reported` is what the account's list says when it says anything
    /// (`online`, `asleep`, `offline`): it wins over the age.
    public static func classify(lastSeen: Date?, reported: String? = nil, now: Date = Date()) -> MacPresence {
        switch reported {
        case "online": return .online
        case "asleep": return .asleep(since: lastSeen)
        case "offline": return .offline(since: lastSeen)
        default: break
        }
        guard let lastSeen else { return .unknown }
        let age = now.timeIntervalSince(lastSeen)
        if age < onlineWindow { return .online }
        return age < asleepWindow ? .asleep(since: lastSeen) : .offline(since: lastSeen)
    }

    public static let onlineWindow: TimeInterval = 90
    public static let asleepWindow: TimeInterval = 24 * 3600

    public var isOnline: Bool { self == .online }

    public func label(now: Date = Date()) -> String {
        switch self {
        case .online: return "Online"
        case let .asleep(since): return since.map { "Asleep \u{00B7} last seen \(MacPresence.ago($0, now: now))" } ?? "Asleep"
        case let .offline(since): return since.map { "Offline \u{00B7} last seen \(MacPresence.ago($0, now: now))" } ?? "Offline"
        case .unknown: return "Tap to open"
        }
    }

    /// An asleep Mac says so, and that waking it is enough: it does not look broken.
    public var hint: String? {
        switch self {
        case .asleep: return "Your Mac is asleep. Open it and Squeak connects as soon as it wakes."
        case .offline: return "Your Mac isn't reachable. It needs to be on and online."
        default: return nil
        }
    }

    static func ago(_ date: Date, now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(date)))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(seconds / 60) min ago" }
        if seconds < 86400 { return "\(seconds / 3600) h ago" }
        return "\(seconds / 86400) d ago"
    }
}

/// One line of "Your Macs": what the account lists merged with what this phone holds.
public struct MacRow: Equatable, Identifiable, Sendable {
    public let macId: String
    public let name: String
    public let presence: MacPresence
    /// This phone already has the Mac (opening it is instant).
    public let held: Bool
    /// The Mac that is open now.
    public let isActive: Bool
    /// The account says this Mac asks before adding a device.
    public let requiresApproval: Bool
    public var id: String { macId }
}

public enum MacList {
    /// The account's Macs first (its order), then any Mac this phone holds that the account does not list (a QR
    /// pairing). The account's name and `lastSeen` win when present; the phone's own last answer fills the gaps.
    public static func rows(account: [AccountMac], registry: MacRegistry, now: Date = Date()) -> [MacRow] {
        var rows: [MacRow] = []
        var seen = Set<String>()
        for mac in account {
            guard seen.insert(mac.macId).inserted else { continue }
            let held = registry.entry(for: mac.macId)
            let lastSeen = [mac.lastSeenAt, held?.lastSeen].compactMap { $0 }.max()
            rows.append(MacRow(macId: mac.macId, name: mac.name, presence: .classify(lastSeen: lastSeen, reported: mac.state, now: now),
                               held: held != nil, isActive: registry.activeId == mac.macId,
                               requiresApproval: mac.requiresApproval == true))
        }
        for entry in registry.entries where !seen.contains(entry.macId) {
            rows.append(MacRow(macId: entry.macId, name: entry.name, presence: .classify(lastSeen: entry.lastSeen, now: now),
                               held: true, isActive: registry.activeId == entry.macId, requiresApproval: false))
        }
        return rows
    }
}

/// What the signed-out screen offers, decided here so it is tested and the view only draws. Signing in is the one
/// way in; the scanner and the pasted link live behind a single small link for a Mac that is not on an account yet.
public enum SignInScreen {
    public enum Entry: Equatable, Sendable { case signIn, macNotOnAccount }

    public static let title = "Sign in to Squeak"
    public static let detail = "Your Macs are here as soon as you do."
    public static let signInLabel = "Sign in"
    public static let providers = "Zoho, Google or email"
    /// The only way to the scanner and the code; for a Mac that has not moved to an account.
    public static let fallbackLabel = "Mac not on an account yet?"
    public static let entries: [Entry] = [.signIn, .macNotOnAccount]

    /// While a Mac is being opened, and only when it asked first.
    public static func opening(_ mac: String, needsApproval: Bool) -> String {
        needsApproval ? "Waiting for \(mac.isEmpty ? "your Mac" : mac) to approve" : "Opening \(mac.isEmpty ? "your Mac" : mac)\u{2026}"
    }
}
