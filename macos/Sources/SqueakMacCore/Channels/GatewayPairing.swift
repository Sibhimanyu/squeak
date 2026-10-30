import Foundation

/// The phone-call gateway (the Home Assistant add-on): `GET /control/voice/gateway`,
/// `POST /control/voice/gateway/pair` and `/approve`. The daemon owns the rules; this only decodes
/// tolerantly and words the status in plain sentences. Times are milliseconds since 1970.
public enum GatewayPairState: String, Sendable, Equatable {
    case waiting, request, done, expired
}

public enum GatewayStatusState: String, Sendable, Equatable {
    case none, stale, ok, sipDown
}

public struct GatewayPairing: Sendable, Equatable, Decodable {
    public var state: GatewayPairState
    public var expiresAt: Double?
    public var name: String?
    public var version: String?
    public var verify: String?

    public init(state: GatewayPairState, expiresAt: Double? = nil, name: String? = nil, version: String? = nil, verify: String? = nil) {
        self.state = state; self.expiresAt = expiresAt; self.name = name; self.version = version; self.verify = verify
    }

    private enum Keys: String, CodingKey { case state, expiresAt, name, version, verify }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        // An unknown state reads as the safest one: nothing to approve.
        state = (try? c.decode(String.self, forKey: .state)).flatMap(GatewayPairState.init(rawValue:)) ?? .waiting
        expiresAt = try? c.decode(Double.self, forKey: .expiresAt)
        name = try? c.decode(String.self, forKey: .name)
        version = try? c.decode(String.self, forKey: .version)
        verify = try? c.decode(String.self, forKey: .verify)
    }
}

public struct GatewayStatus: Sendable, Equatable, Decodable {
    public var state: GatewayStatusState
    public var version: String?
    public var sipRegistered: Bool?
    public var sipError: String?
    public var at: Double?

    public init(state: GatewayStatusState = .none, version: String? = nil, sipRegistered: Bool? = nil, sipError: String? = nil, at: Double? = nil) {
        self.state = state; self.version = version; self.sipRegistered = sipRegistered; self.sipError = sipError; self.at = at
    }

    private enum Keys: String, CodingKey { case state, version, sipRegistered, sipError, at }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        state = (try? c.decode(String.self, forKey: .state)).flatMap(GatewayStatusState.init(rawValue:)) ?? .none
        version = try? c.decode(String.self, forKey: .version)
        sipRegistered = try? c.decode(Bool.self, forKey: .sipRegistered)
        sipError = try? c.decode(String.self, forKey: .sipError)
        at = try? c.decode(Double.self, forKey: .at)
    }
}

public struct GatewayView: Sendable, Equatable, Decodable {
    public var pairing: GatewayPairing?
    public var status: GatewayStatus
    /// The newest add-on version the add-on knows of, and whether it is newer than the running one (computed by the daemon).
    public var latestVersion: String?
    public var updateAvailable: Bool
    /// When the daemon last looked for a newer add-on (ms since 1970).
    public var checkedAt: Double?

    public init(pairing: GatewayPairing? = nil, status: GatewayStatus = GatewayStatus(), latestVersion: String? = nil, updateAvailable: Bool = false, checkedAt: Double? = nil) {
        self.pairing = pairing; self.status = status; self.latestVersion = latestVersion; self.updateAvailable = updateAvailable; self.checkedAt = checkedAt
    }

    private enum Keys: String, CodingKey { case pairing, status, latestVersion, updateAvailable, checkedAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        pairing = try? c.decode(GatewayPairing.self, forKey: .pairing)
        status = (try? c.decode(GatewayStatus.self, forKey: .status)) ?? GatewayStatus()
        latestVersion = try? c.decode(String.self, forKey: .latestVersion)
        updateAvailable = (try? c.decode(Bool.self, forKey: .updateAvailable)) ?? false
        checkedAt = try? c.decode(Double.self, forKey: .checkedAt)
    }

    /// "Add-on 0.9.2 · 0.10.0 is available", or nil when there is nothing to update to.
    public var updateLine: String? { GatewayText.updateLine(self) }

    /// The line shown whenever the gateway is paired and reporting: available, up to date, or just the version.
    public var versionLine: String? { GatewayText.versionLine(self) }

    /// True once a gateway has ever reported in, so the button reads "Pair again".
    public var isPaired: Bool { status.state != .none }

    /// One plain sentence for the status line.
    public func statusLine(now: Date = Date()) -> String { GatewayText.statusLine(status, now: now) }
}

/// `POST /control/voice/gateway/pair` answer.
public struct GatewayPairResponse: Sendable, Equatable, Decodable {
    public var ok: Bool
    public var code: String
    public var expiresAt: Double

    public init(ok: Bool, code: String, expiresAt: Double) { self.ok = ok; self.code = code; self.expiresAt = expiresAt }
}

public enum GatewayText {
    public static func statusLine(_ s: GatewayStatus, now: Date = Date()) -> String {
        let addon = s.version.map { "Home Assistant add-on \($0)" } ?? "Home Assistant add-on"
        switch s.state {
        case .none:
            return "No gateway paired yet"
        case .ok:
            return "\(addon) · connected"
        case .stale:
            if let at = s.at {
                let minutes = max(1, Int((now.timeIntervalSince1970 - at / 1000) / 60))
                return "Not heard from in \(duration(minutes: minutes))"
            }
            return "Not heard from lately"
        case .sipDown:
            if let e = s.sipError, !e.trimmingCharacters(in: .whitespaces).isEmpty {
                return "Add-on can't reach your PBX: \(e)"
            }
            return "Add-on can't reach your PBX"
        }
    }

    public static func updateLine(_ g: GatewayView) -> String? {
        guard g.updateAvailable, let latest = g.latestVersion, !latest.isEmpty else { return nil }
        let now = g.status.version.map { "Add-on \($0) · " } ?? ""
        return "\(now)\(latest) is available"
    }

    /// "Add-on 0.10.0 · up to date", "Add-on 0.10.0 · 0.10.1 is available", plain "Add-on 0.10.0", or nil when the add-on has not reported a version.
    public static func versionLine(_ g: GatewayView) -> String? {
        if let line = updateLine(g) { return line }
        guard g.status.state != .none, let v = g.status.version, !v.isEmpty else { return nil }
        if !g.updateAvailable, let latest = g.latestVersion, latest == v { return "Add-on \(v) · up to date" }
        return "Add-on \(v)"
    }

    public static let checkedJustNow = "Checked just now"

    public static let updating = "Updating the add-on… it restarts in a minute"

    /// Shown instead of a spinner once the add-on neither restarted nor changed version in time.
    public static let updateTimedOut =
        "The add-on didn't update. Open Home Assistant › Settings › Add-ons › Squeak Voice and press Update (Home Assistant may not have seen the new version yet)."

    public static func updated(_ version: String) -> String { "Updated to \(version)" }

    static func duration(minutes: Int) -> String {
        if minutes < 60 { return "\(minutes) min" }
        let h = minutes / 60
        if h < 48 { return h == 1 ? "1 hour" : "\(h) hours" }
        return "\(h / 24) days"
    }

    /// "9:41" style countdown, or nil once it has passed.
    public static func countdown(expiresAt: Double, now: Date = Date()) -> String? {
        let left = Int((expiresAt / 1000 - now.timeIntervalSince1970).rounded(.up))
        if left <= 0 { return nil }
        return String(format: "%d:%02d", left / 60, left % 60)
    }

    public static func requestSentence(_ p: GatewayPairing) -> String {
        let who = "Squeak Voice" + (p.version.map { " (add-on \($0))" } ?? "")
        let check = p.verify.map { "Confirm \($0) matches the number in the add-on's log." } ?? "Confirm it is yours."
        return "\(who) wants to connect. \(check)"
    }

    public static func approveBody(_ approve: Bool) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["approve": approve], options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}

/// What typing the add-on's code came to.
public enum GatewayClaimOutcome: Sendable, Equatable {
    /// The add-on answered: now wait for Approve.
    case found(name: String?, version: String?)
    /// The daemon's own plain sentence.
    case refused(String)
    /// A daemon without the claim route: use the old code-making flow.
    case unavailable
}

public enum GatewayClaim {
    /// `{"code":"K7M2-QX9P"}` with the code normalised to its display form.
    public static func requestBody(code: String) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["code": display(code)], options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    /// Uppercase, spaces and dashes dropped, then a dash after 4 characters: "k7m2 qx9p" -> "K7M2-QX9P".
    public static func display(_ typed: String) -> String {
        let chars = typed.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(8)
        let s = String(chars)
        return s.count > 4 ? s.prefix(4) + "-" + s.dropFirst(4) : s
    }

    /// A full code is 8 characters.
    public static func isComplete(_ typed: String) -> Bool {
        typed.uppercased().filter { $0.isLetter || $0.isNumber }.count == 8
    }

    public static func outcome(status: Int, body: Data) -> GatewayClaimOutcome {
        let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let sentence = (o?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        if (200..<300).contains(status), o?["ok"] as? Bool != false {
            return .found(name: o?["name"] as? String, version: o?["version"] as? String)
        }
        // A 404 with a sentence is the daemon saying the code is unknown; without one the route is missing.
        if status == 404 && sentence == nil { return .unavailable }
        return .refused(sentence ?? "Squeak could not use that code. Check it and try again.")
    }
}

public enum GatewayClaimText {
    /// "Squeak Voice (add-on 0.9.0) wants to connect."
    public static func confirm(_ p: GatewayPairing) -> String {
        let who = (p.name?.isEmpty == false ? p.name! : "Squeak Voice") + (p.version.map { " (add-on \($0))" } ?? "")
        return "\(who) wants to connect."
    }
}

/// What `POST /control/voice/gateway/update` came to.
public enum GatewayUpdateOutcome: Sendable, Equatable {
    case done
    /// The daemon's own plain sentence.
    case refused(String)
    /// A daemon without the route.
    case unavailable
}

public enum GatewayUpdate {
    public static let requestBody = Data("{}".utf8)

    public static func outcome(status: Int, body: Data) -> GatewayUpdateOutcome {
        let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let sentence = (o?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        if (200..<300).contains(status), o?["ok"] as? Bool != false { return .done }
        if status == 404 && sentence == nil { return .unavailable }
        return .refused(sentence ?? "Squeak could not update the add-on. Try again, or update it in Home Assistant.")
    }
}

/// What `POST /control/voice/gateway/check` came to.
public enum GatewayCheckOutcome: Sendable, Equatable {
    case checked(latestVersion: String?, updateAvailable: Bool, checkedAt: Double?)
    /// The daemon's own plain sentence.
    case refused(String)
    /// A daemon without the route (404 and no sentence): the Check button hides.
    case unavailable
}

public enum GatewayCheck {
    public static let requestBody = Data("{}".utf8)

    public static func outcome(status: Int, body: Data) -> GatewayCheckOutcome {
        let o = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
        let sentence = (o?["error"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        if (200..<300).contains(status), o?["ok"] as? Bool != false {
            return .checked(latestVersion: o?["latestVersion"] as? String,
                            updateAvailable: o?["updateAvailable"] as? Bool ?? false,
                            checkedAt: (o?["checkedAt"] as? NSNumber)?.doubleValue)
        }
        if status == 404 && sentence == nil { return .unavailable }
        return .refused(sentence ?? "Squeak could not check for an add-on update. Try again in a moment.")
    }
}

/// The add-on updating after "Update add-on", as a state machine over what the gateway reports. Pure: the caller feeds
/// it the status and a clock, so the timeouts are testable. requested -> updating -> updated(version) | timedOut.
/// Home Assistant stops the add-on to update it, so its status going quiet (`stale`) is the restart being seen: the
/// wait is then longer (the add-on needs time to come back). Never an endless spinner.
public struct GatewayUpdateWatch: Sendable, Equatable {
    public enum Phase: Sendable, Equatable {
        case updating
        case updated(String)
        case timedOut
    }

    /// Seconds from the request until "didn't update", when the add-on never went quiet.
    public static let timeout: TimeInterval = 120
    /// The same, once the add-on has gone down for the update: it gets this long to come back with the new version.
    public static let comeBackTimeout: TimeInterval = 180

    public let target: String
    public let from: String?
    public let requestedAt: Date
    public private(set) var sawRestart = false
    public private(set) var phase: Phase = .updating

    public init(target: String, from: String?, requestedAt: Date) {
        self.target = target; self.from = from; self.requestedAt = requestedAt
    }

    /// When the wait ends if nothing arrives.
    public var deadline: Date { requestedAt.addingTimeInterval(sawRestart ? Self.comeBackTimeout : Self.timeout) }

    /// Feeds one look at the gateway; returns the phase after it. Once done or timed out it stays so.
    @discardableResult
    public mutating func observe(_ status: GatewayStatus, now: Date) -> Phase {
        guard phase == .updating else { return phase }
        if status.state == .stale { sawRestart = true }
        if status.state != .none, status.state != .stale, let v = status.version, Self.version(v, atLeast: target) {
            phase = .updated(v)
        } else if now >= deadline {
            phase = .timedOut
        }
        return phase
    }

    /// `x.y.z` compared per part; false when either side is not that shape.
    static func version(_ v: String, atLeast target: String) -> Bool {
        let a = v.split(separator: ".").compactMap { Int($0) }, b = target.split(separator: ".").compactMap { Int($0) }
        guard a.count == 3, b.count == 3 else { return v == target }
        for i in 0..<3 where a[i] != b[i] { return a[i] > b[i] }
        return true
    }
}
