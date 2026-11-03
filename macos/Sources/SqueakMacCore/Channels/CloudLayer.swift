import Foundation

// The cloud layer's Mac side (docs/cloud-layer.md): where the phone channel lives, Firebase or Catalyst.
// Decoding is tolerant on purpose: a newer daemon may add steps, states or blocks, and a missing block
// simply hides its card.

public enum CloudProvider: String, Sendable, CaseIterable {
    case firebase, catalyst
    public var title: String { self == .firebase ? "Firebase" : "Catalyst" }
}

public enum CloudProviderStatus: Sendable, Equatable {
    case inUse, ready, notSetUp
    public var text: String {
        switch self { case .inUse: "In use"; case .ready: "Ready"; case .notSetUp: "Not set up" }
    }
}

/// A test's numbers (`lastTest` or the answer to `POST /control/cloud/test`).
public struct CloudTest: Decodable, Sendable, Equatable {
    public var at: Double?
    public var ok: Bool
    public var writeMs: Int?
    public var readMs: Int?
    public var noticeMs: Int?
    public var error: String?

    public init(at: Double? = nil, ok: Bool, writeMs: Int? = nil, readMs: Int? = nil, noticeMs: Int? = nil, error: String? = nil) {
        self.at = at; self.ok = ok; self.writeMs = writeMs; self.readMs = readMs; self.noticeMs = noticeMs; self.error = error
    }

    private enum Keys: String, CodingKey { case at, ok, writeMs, readMs, noticeMs, error }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        at = try? c.decode(Double.self, forKey: .at)
        ok = (try? c.decode(Bool.self, forKey: .ok)) ?? false
        writeMs = Self.ms(c, .writeMs); readMs = Self.ms(c, .readMs); noticeMs = Self.ms(c, .noticeMs)
        error = try? c.decode(String.self, forKey: .error)
    }
    private static func ms(_ c: KeyedDecodingContainer<Keys>, _ k: Keys) -> Int? {
        if let i = try? c.decode(Int.self, forKey: k) { return i }
        if let d = try? c.decode(Double.self, forKey: k) { return Int(d.rounded()) }
        return nil
    }
}

public struct CloudFirebase: Decodable, Sendable, Equatable {
    public var configured: Bool
    public var projectId: String?
    public var databaseUrl: String?
    public var lastTest: CloudTest?

    public init(configured: Bool, projectId: String? = nil, databaseUrl: String? = nil, lastTest: CloudTest? = nil) {
        self.configured = configured; self.projectId = projectId; self.databaseUrl = databaseUrl; self.lastTest = lastTest
    }
    private enum Keys: String, CodingKey { case configured, projectId, databaseUrl, lastTest }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        projectId = try? c.decode(String.self, forKey: .projectId)
        databaseUrl = try? c.decode(String.self, forKey: .databaseUrl)
        configured = (try? c.decode(Bool.self, forKey: .configured)) ?? (databaseUrl != nil)
        lastTest = try? c.decode(CloudTest.self, forKey: .lastTest)
    }
}

public struct CloudCLI: Decodable, Sendable, Equatable {
    public var installed: Bool
    public var version: String?
    public var loggedIn: Bool
    public var org: String?

    public init(installed: Bool, version: String? = nil, loggedIn: Bool, org: String? = nil) {
        self.installed = installed; self.version = version; self.loggedIn = loggedIn; self.org = org
    }
    private enum Keys: String, CodingKey { case installed, version, loggedIn, org }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        installed = (try? c.decode(Bool.self, forKey: .installed)) ?? false
        version = try? c.decode(String.self, forKey: .version)
        loggedIn = (try? c.decode(Bool.self, forKey: .loggedIn)) ?? false
        org = try? c.decode(String.self, forKey: .org)
    }
}

public enum CloudStepState: Sendable, Equatable {
    case done, todo, working, error
    /// A state this app does not know: shown generically, never hidden.
    case unknown(String)

    init(_ raw: String) {
        switch raw {
        case "done": self = .done
        case "todo": self = .todo
        case "working": self = .working
        case "error": self = .error
        default: self = .unknown(raw)
        }
    }
}

public struct CloudStep: Decodable, Sendable, Equatable, Identifiable {
    public var id: String
    public var state: CloudStepState
    public var detail: String?
    public var consoleUrl: String?

    public init(id: String, state: CloudStepState, detail: String? = nil, consoleUrl: String? = nil) {
        self.id = id; self.state = state; self.detail = detail; self.consoleUrl = consoleUrl
    }
    private enum Keys: String, CodingKey { case id, state, detail, consoleUrl }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        state = CloudStepState((try? c.decode(String.self, forKey: .state)) ?? "")
        detail = try? c.decode(String.self, forKey: .detail)
        consoleUrl = try? c.decode(String.self, forKey: .consoleUrl)
    }

    /// The URL to open, only if it is https (a daemon's string is never opened blindly).
    public var consoleURL: URL? {
        guard let s = consoleUrl, let u = URL(string: s), u.scheme == "https", u.host != nil else { return nil }
        return u
    }
}

public struct CloudCatalyst: Decodable, Sendable, Equatable {
    public var configured: Bool
    public var cli: CloudCLI?
    public var projectId: String?
    public var projectName: String?
    public var dc: String?
    public var appUrl: String?
    public var steps: [CloudStep]
    public var lastTest: CloudTest?

    public init(configured: Bool, cli: CloudCLI? = nil, projectId: String? = nil, projectName: String? = nil, dc: String? = nil,
                appUrl: String? = nil, steps: [CloudStep] = [], lastTest: CloudTest? = nil) {
        self.configured = configured; self.cli = cli; self.projectId = projectId; self.projectName = projectName
        self.dc = dc; self.appUrl = appUrl; self.steps = steps; self.lastTest = lastTest
    }
    private enum Keys: String, CodingKey { case configured, cli, projectId, projectName, dc, appUrl, steps, lastTest }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        configured = (try? c.decode(Bool.self, forKey: .configured)) ?? false
        cli = try? c.decode(CloudCLI.self, forKey: .cli)
        projectId = try? c.decode(String.self, forKey: .projectId)
        projectName = try? c.decode(String.self, forKey: .projectName)
        dc = try? c.decode(String.self, forKey: .dc)
        appUrl = try? c.decode(String.self, forKey: .appUrl)
        // One unreadable step is dropped rather than hiding the whole list.
        steps = (try? c.decode([Lossy<CloudStep>].self, forKey: .steps))?.compactMap(\.value) ?? []
        lastTest = try? c.decode(CloudTest.self, forKey: .lastTest)
    }
}

private struct Lossy<T: Decodable & Sendable>: Decodable, Sendable {
    var value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

public struct CloudState: Decodable, Sendable, Equatable {
    public var active: String?
    /// nil: the daemon did not send the block, so its card is hidden.
    public var firebase: CloudFirebase?
    public var catalyst: CloudCatalyst?

    public init(active: String? = nil, firebase: CloudFirebase? = nil, catalyst: CloudCatalyst? = nil) {
        self.active = active; self.firebase = firebase; self.catalyst = catalyst
    }
    private enum Keys: String, CodingKey { case active, firebase, catalyst }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        active = try? c.decode(String.self, forKey: .active)
        firebase = try? c.decode(CloudFirebase.self, forKey: .firebase)
        catalyst = try? c.decode(CloudCatalyst.self, forKey: .catalyst)
    }

    public func status(_ p: CloudProvider) -> CloudProviderStatus {
        if active == p.rawValue { return .inUse }
        switch p {
        case .firebase: return firebase?.configured == true ? .ready : .notSetUp
        case .catalyst: return catalyst?.configured == true ? .ready : .notSetUp
        }
    }

    public func lastTest(_ p: CloudProvider) -> CloudTest? {
        switch p { case .firebase: firebase?.lastTest; case .catalyst: catalyst?.lastTest }
    }

    /// Write / read / change-notice side by side, only when both providers have a test.
    public var comparison: [CloudComparisonRow]? {
        guard let f = firebase?.lastTest, let c = catalyst?.lastTest else { return nil }
        return [
            CloudComparisonRow(label: "Write", firebaseMs: f.writeMs, catalystMs: c.writeMs),
            CloudComparisonRow(label: "Read", firebaseMs: f.readMs, catalystMs: c.readMs),
            CloudComparisonRow(label: "Change notice", firebaseMs: f.noticeMs, catalystMs: c.noticeMs),
        ]
    }

    /// A Catalyst step is working: the card polls until it is not.
    public var catalystBusy: Bool { catalyst?.steps.contains { $0.state == .working } ?? false }
}

public struct CloudComparisonRow: Sendable, Equatable {
    public var label: String
    public var firebaseMs: Int?
    public var catalystMs: Int?
    public static func format(_ ms: Int?) -> String { ms.map { "\($0) ms" } ?? "-" }
}

public struct CloudProject: Decodable, Sendable, Equatable, Identifiable, Hashable {
    public var id: String
    public var name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
    private enum Keys: String, CodingKey { case id, name }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        if let s = try? c.decode(String.self, forKey: .id) { id = s } else { id = String(try c.decode(Int.self, forKey: .id)) }
        name = (try? c.decode(String.self, forKey: .name)) ?? id
    }
}

/// What a write route answers: `{ ok, error? }` (plus `moved` for a select).
public struct CloudAck: Sendable, Equatable {
    public var ok: Bool
    public var moved: Bool
    public var error: String?
    public static let olderDaemon = CloudAck(ok: false, moved: false, error: "Update the Squeak service on this Mac to do that.")
    public static func failed(_ s: String) -> CloudAck { CloudAck(ok: false, moved: false, error: s) }
}

// MARK: - What each setup step shows

/// One value to type into Catalyst's console, with its one-tap Copy.
public struct CloudField: Sendable, Equatable {
    public var label: String
    public var value: String
}

public enum CloudStepAction: Sendable, Equatable {
    /// "Install": the exact command, copyable.
    case install(command: String)
    /// "Sign in": runs nothing; `catalyst login` opens the browser.
    case signIn(command: String)
    /// "Open console", then the project picker and "Use this project".
    case chooseProject
    case openConsole
    case deploy
    case test
    case none
}

/// Everything a step row shows, derived from the step and the CLI block. Unknown ids get their raw name and no action.
public struct CloudStepPresentation: Sendable, Equatable {
    public var title: String
    public var instruction: String
    public var action: CloudStepAction
    public var fields: [CloudField]
    /// Exact words for the console, when the step is clicked through there.
    public var consoleSteps: [String]

    public static let installCommand = "npm i -g zcatalyst-cli"
    public static let loginCommand = "catalyst login"

    public static func make(step: CloudStep, cli: CloudCLI?) -> CloudStepPresentation {
        let done = step.state == .done
        switch step.id {
        case "cli":
            let action: CloudStepAction
            let instruction: String
            if done {
                action = .none
                instruction = cli?.version.map { "Catalyst CLI \($0) is installed and signed in." } ?? "Catalyst CLI is installed and signed in."
            } else if cli?.installed == true {
                action = .signIn(command: loginCommand); instruction = "Sign in to Catalyst. This opens your browser."
            } else {
                action = .install(command: installCommand); instruction = "Install the Catalyst command line tool, then sign in."
            }
            return .init(title: "Catalyst command line tool", instruction: instruction, action: action, fields: [], consoleSteps: [])
        case "project":
            return .init(title: "Project", instruction: done ? "A project is selected." : "Create a project in the console, then pick it here.",
                         action: done ? .none : .chooseProject, fields: [],
                         consoleSteps: ["Click Create Project", "Give it any name, for example squeak"])
        case "table":
            return .init(title: "Table", instruction: "Create the table Squeak stores its sealed documents in.",
                         action: done ? .none : .openConsole,
                         fields: [.init(label: "Table name", value: "squeak_docs"), .init(label: "Partition key", value: "pk"),
                                  .init(label: "Sort key", value: "doc"), .init(label: "Key type", value: "String")],
                         consoleSteps: ["Cloud Scale, then NoSQL, then Create Table", "Make both keys type String"])
        case "deploy":
            return .init(title: "Relay function", instruction: done ? "The relay function is deployed." : "Squeak deploys its small relay function to your project.",
                         action: done ? .none : .deploy, fields: [], consoleSteps: [])
        case "channel":
            return .init(title: "Change notices", instruction: "Create the channel that wakes devices when something changes.",
                         action: done ? .none : .openConsole,
                         fields: [.init(label: "Channel name", value: "squeak_notice"), .init(label: "Access control", value: "Custom Logic"),
                                  .init(label: "Function", value: "squeak_relay")],
                         consoleSteps: ["Cloud Scale, then Data Streams, then Create Channel", "Set access control to Custom Logic and pick the function"])
        case "verify":
            return .init(title: "Test", instruction: done ? "A test round trip worked." : "Check that a write, a read and a change notice make it round.",
                         action: .test, fields: [], consoleSteps: [])
        default:
            return .init(title: step.id, instruction: step.detail ?? "", action: .none, fields: [], consoleSteps: [])
        }
    }
}

public enum CloudConsole {
    /// The console for a data centre (`https://console.catalyst.zoho.<tld>`); unknown or missing is India's, this app's home.
    public static func url(dc: String?) -> URL {
        let tld: String
        switch (dc ?? "").lowercased() {
        case "us", "com": tld = "com"
        case "eu": tld = "eu"
        case "au", "com.au": tld = "com.au"
        case "jp": tld = "jp"
        case "ca": tld = "ca"
        case "sa": tld = "sa"
        default: tld = "in"
        }
        return URL(string: "https://console.catalyst.zoho.\(tld)")!
    }
}

/// Catalyst has no rename API; these are the console steps the tab shows instead.
public enum CloudRename {
    public static let catalystConsoleSteps = [
        "Open the Catalyst console and choose your project.",
        "Go to Settings, then Project Settings.",
        "Change the project name and save.",
    ]
}

// MARK: - Routes

extension DaemonClient {
    /// nil when the daemon has no `/control/cloud` (404): an older daemon, so the Cloud tab is hidden.
    public func cloudState() async throws -> CloudState? {
        let r = try await getControl("/control/cloud")
        if r.status == 404 { return nil }
        if r.status == 401 || r.status == 403 { throw AdapterError.tokenRejected }
        guard (200..<300).contains(r.status) else { throw AdapterError.http(r.status) }
        guard let s = try? JSONDecoder().decode(CloudState.self, from: r.body) else { throw AdapterError.badResponse("unreadable CloudState") }
        return s
    }

    /// The CLI's projects for the picker; nil on an older daemon.
    public func catalystProjects() async throws -> [CloudProject]? {
        let r = try await getControl("/control/cloud/catalyst/projects")
        if r.status == 404 { return nil }
        if r.status == 401 || r.status == 403 { throw AdapterError.tokenRejected }
        guard (200..<300).contains(r.status) else { throw AdapterError.http(r.status) }
        struct Body: Decodable { var projects: [Lossy<CloudProject>]? }
        let b = try? JSONDecoder().decode(Body.self, from: r.body)
        return (b?.projects ?? []).compactMap(\.value)
    }

    public func selectCatalystProject(id: String) async -> CloudAck { await cloudPost("/control/cloud/catalyst/project", ["projectId": id], timeout: 60) }
    public func deployCatalyst() async -> CloudAck { await cloudPost("/control/cloud/catalyst/deploy", [:], timeout: 240) }
    public func checkCatalyst() async -> CloudAck { await cloudPost("/control/cloud/catalyst/check", [:], timeout: 60) }
    public func renameFirebase(displayName: String) async -> CloudAck { await cloudPost("/control/cloud/firebase/rename", ["displayName": displayName], timeout: 60) }
    public func selectCloud(_ provider: CloudProvider) async -> CloudAck { await cloudPost("/control/cloud/select", ["provider": provider.rawValue], timeout: 120) }

    /// A failed test is a result with `ok: false`, never a throw.
    public func testCloud(_ provider: CloudProvider) async -> CloudTest {
        do {
            let r = try await cloudSend("/control/cloud/test", ["provider": provider.rawValue], timeout: 90)
            if r.status == 404 { return CloudTest(ok: false, error: CloudAck.olderDaemon.error) }
            if let t = try? JSONDecoder().decode(CloudTest.self, from: r.body), r.status < 500 { return t }
            return CloudTest(ok: false, error: "The test didn't finish.")
        } catch AdapterError.tokenMissing {
            return CloudTest(ok: false, error: "Squeak's access token was not found")
        } catch {
            return CloudTest(ok: false, error: "Squeak isn't running.")
        }
    }

    private func cloudPost(_ path: String, _ fields: [String: String], timeout: TimeInterval) async -> CloudAck {
        do {
            let r = try await cloudSend(path, fields, timeout: timeout)
            if r.status == 404 { return .olderDaemon }
            if r.status == 401 || r.status == 403 { return .failed("Squeak rejected the access token") }
            struct Body: Decodable { var ok: Bool?; var moved: Bool?; var error: String? }
            guard let b = try? JSONDecoder().decode(Body.self, from: r.body) else {
                return (200..<300).contains(r.status) ? CloudAck(ok: true, moved: false, error: nil) : .failed("That didn't work.")
            }
            let ok = b.ok ?? (200..<300).contains(r.status)
            return CloudAck(ok: ok, moved: b.moved ?? false, error: ok ? nil : (b.error ?? "That didn't work."))
        } catch AdapterError.tokenMissing {
            return .failed("Squeak's access token was not found")
        } catch {
            return .failed("Squeak isn't running.")
        }
    }

    private func cloudSend(_ path: String, _ fields: [String: String], timeout: TimeInterval) async throws -> HTTPResponse {
        guard let t = tokenProvider() else { throw AdapterError.tokenMissing }
        let body = (try? JSONEncoder().encode(fields)) ?? Data("{}".utf8)
        do {
            return try await transportForControl.send(HTTPRequest(
                method: "POST", url: controlURL(path), headers: ["x-squeak-token": t, "content-type": "application/json"],
                body: body, timeout: timeout))
        } catch is TransportError {
            throw AdapterError.daemonDown
        }
    }
}
