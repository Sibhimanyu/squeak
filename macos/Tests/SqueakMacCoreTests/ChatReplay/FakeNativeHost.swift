import Foundation
@testable import SqueakMacCore

/// A scripted Squeak session host for replay tests: serves the routes `NativeHostClient` calls from state the test
/// changes over time, in the shapes the real host sends (`src/native/server.ts`; the JSON keys are the ones the
/// recorded fixtures under Fixtures/native carry). No network. `down` is the host (or the daemon) not answering.
final class FakeNativeHost: HTTPTransport, @unchecked Sendable {
    struct Chat {
        var id: String
        var agent = "claude"
        var status = "idle"
        var background = 0
        /// The ducklings contract's `ducklings` field; nil = a host that predates it.
        var ducklings: [String: Any]?
        var ducklingDetails: [String: [String: Any]] = [:]
        var rows: [[String: Any]] = []
        var pending: [[String: Any]] = []
        var requests: [[String: Any]] = []
        var lastTurnEndedAt: Date?
        var updatedAt: Date
    }

    private let lock = NSLock()
    private var chats: [String: Chat] = [:]
    private var _down = false
    private var _failSends = 0
    private var _recording = false
    private var _outbox: [NativeEvent] = []
    private var _log: [String] = []
    private let clock: FakeClock
    /// What a POST /messages does; the default is an idle chat taking the message and starting to work.
    var onSend: @Sendable (FakeNativeHost, String, String, SendMode) -> Bool = { host, id, text, mode in
        host.defaultSend(id, text, mode)
    }

    init(clock: FakeClock) { self.clock = clock }

    var down: Bool {
        get { lock.withLock { _down } }
        set { lock.withLock { _down = newValue } }
    }
    /// The next this-many POST /messages are refused at the connection (the host restarting), then it answers again.
    var failNextSends: Int {
        get { lock.withLock { _failSends } }
        set { lock.withLock { _failSends = newValue } }
    }
    /// "METHOD /path" of every request that reached a route.
    var log: [String] { lock.withLock { _log } }

    func addChat(_ id: String, agent: String = "claude") {
        lock.withLock { chats[id] = Chat(id: id, agent: agent, updatedAt: clock.now()) }
    }

    /// What the host streams as a result of a request the Mac made (rows and statuses its handler wrote): the app's
    /// stream delivers these; a test's own `deliver` passes the ones it scripts itself.
    func takeOutbox() -> [NativeEvent] { lock.withLock { defer { _outbox = [] }; return _outbox } }

    private func record(_ e: NativeEvent) -> NativeEvent {
        lock.withLock { if _recording { _outbox.append(e) } }
        return e
    }

    /// What the host reports as the chat's helpers (`running` and the items), or nil to omit the field.
    func setDucklings(_ id: String, items: [[String: Any]]?) {
        lock.withLock {
            chats[id]!.ducklings = items.map { ["running": $0.filter { $0["status"] as? String == "running" }.count, "items": $0] }
        }
    }

    func setDucklingDetail(_ id: String, task: String, _ detail: [String: Any]) { lock.withLock { chats[id]!.ducklingDetails[task] = detail } }

    func chat(_ id: String) -> Chat { lock.withLock { chats[id]! } }

    func modify(_ id: String, _ change: (inout Chat) -> Void) { lock.withLock { change(&chats[id]!) } }

    // MARK: Writing the host's state (each returns the stream event the host would send)

    @discardableResult
    func addRow(_ id: String, role: String, kind: String, _ payload: [String: Any]) -> NativeEvent {
        let now = clock.now()
        let (seq, json): (Int, [String: Any]) = lock.withLock {
            let seq = (chats[id]!.rows.last?["seq"] as? Int ?? 0) + 1
            let row: [String: Any] = [
                "seq": seq, "sessionId": id, "role": role, "kind": kind, "payload": payload,
                "createdAt": Self.iso(now),
            ]
            chats[id]!.rows.append(row)
            chats[id]!.updatedAt = now
            return (seq, row)
        }
        _ = seq
        let data = try! JSONSerialization.data(withJSONObject: json)
        return record(.message(try! JSONDecoder().decode(NativeMessage.self, from: data)))
    }

    @discardableResult func user(_ id: String, _ text: String, steered: Bool = false) -> NativeEvent {
        addRow(id, role: "user", kind: "user/text", steered ? ["text": text, "steered": true] : ["text": text])
    }

    @discardableResult func say(_ id: String, _ text: String) -> NativeEvent {
        addRow(id, role: "agent", kind: "assistant", ["message": ["content": [["type": "text", "text": text]]]])
    }

    @discardableResult func think(_ id: String, _ text: String) -> NativeEvent {
        addRow(id, role: "agent", kind: "assistant", ["message": ["content": [["type": "thinking", "thinking": text]]]])
    }

    @discardableResult func tool(_ id: String, toolId: String, name: String, input: [String: Any]) -> NativeEvent {
        addRow(id, role: "agent", kind: "assistant", ["message": ["content": [["type": "tool_use", "id": toolId, "name": name, "input": input]]]])
    }

    @discardableResult func toolResult(_ id: String, toolId: String, _ content: String, extra: [String: Any] = [:]) -> NativeEvent {
        var payload: [String: Any] = ["message": ["content": [["type": "tool_result", "tool_use_id": toolId, "content": content]]]]
        for (k, v) in extra { payload[k] = v }
        return addRow(id, role: "user", kind: "user", payload)
    }

    @discardableResult func interrupted(_ id: String) -> NativeEvent {
        addRow(id, role: "user", kind: "user", ["message": ["content": [["type": "text", "text": "[Request interrupted by user]"]]]])
    }

    @discardableResult func aborted(_ id: String) -> NativeEvent { addRow(id, role: "system", kind: "system/error", ["text": "aborted by user"]) }

    @discardableResult
    func setStatus(_ id: String, _ status: String, background: Int? = nil, turnEnded: Bool = false) -> NativeEvent {
        let now = clock.now()
        lock.withLock {
            chats[id]!.status = status
            if let background { chats[id]!.background = background }
            if turnEnded { chats[id]!.lastTurnEndedAt = now }
            chats[id]!.updatedAt = now
        }
        return record(.status(status))
    }

    /// A message waiting beside the running turn (`state`: queued or steering; a steer's `seq` is its transcript row).
    @discardableResult
    func addPending(_ id: String, _ pid: String, text: String, state: String, seq: Int? = nil, waitingFor: String? = nil) -> NativeEvent {
        var j: [String: Any] = ["id": pid, "text": text, "state": state, "createdAt": Self.iso(clock.now()), "held": false]
        if let seq { j["seq"] = seq }
        if let waitingFor { j["waitingFor"] = waitingFor }
        lock.withLock { chats[id]!.pending.append(j) }
        let data = try! JSONSerialization.data(withJSONObject: j)
        return record(.pending(.add(try! JSONDecoder().decode(NativePendingItem.self, from: data))))
    }

    @discardableResult
    func removePending(_ id: String, _ pid: String, consumed: Bool, seq: Int? = nil) -> NativeEvent {
        lock.withLock { chats[id]!.pending.removeAll { $0["id"] as? String == pid } }
        return record(.pending(.remove(id: pid, consumed: consumed, seq: seq)))
    }

    /// An open AskUserQuestion: the host streams a `request` frame and lists it under /requests.
    @discardableResult
    func askQuestion(_ id: String, rid: String, question: String, options: [String]) -> NativeEvent {
        let j: [String: Any] = [
            "id": rid, "sessionId": id, "kind": "question",
            "payload": [
                "toolName": "AskUserQuestion", "displayName": "AskUserQuestion", "toolUseID": "tu-\(rid)",
                "input": ["questions": [["question": question, "header": "Pick", "multiSelect": false,
                                         "options": options.map { ["label": $0, "description": ""] }]]],
            ] as [String: Any],
            "createdAt": Self.iso(clock.now()),
        ]
        lock.withLock { chats[id]!.requests.append(j) }
        let data = try! JSONSerialization.data(withJSONObject: j)
        return .request(try! JSONDecoder().decode(NativeRequest.self, from: data))
    }

    func requestResolvedEvent(_ rid: String) -> NativeEvent { .requestResolved(rid) }

    // MARK: Routes

    func defaultSend(_ id: String, _ text: String, _ mode: SendMode) -> Bool {
        if chat(id).status == "idle" || chat(id).status == "error" {
            user(id, text)
            setStatus(id, "working")
            return false
        }
        addPending(id, "q\(chat(id).pending.count + 1)", text: text, state: "queued")
        return true
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let path = request.url.path
        let query = request.url.query ?? ""
        lock.withLock { _log.append("\(request.method) \(path)") }
        if down { throw TransportError.connectionRefused }
        let parts = path.split(separator: "/").map(String.init)  // native sessions <id> [what] [...]
        func ok(_ object: Any) -> HTTPResponse {
            HTTPResponse(status: 200, body: try! JSONSerialization.data(withJSONObject: object))
        }
        guard parts.count >= 2, parts[0] == "native" else { return HTTPResponse(status: 404, body: Data(#"{"error":"not found"}"#.utf8)) }
        if parts[1] == "projects" { return ok(["projects": []]) }
        if parts[1] == "requests", parts.count == 3, request.method == "POST" {
            lock.withLock {
                for id in chats.keys {
                    if chats[id]!.requests.contains(where: { $0["id"] as? String == parts[2] }) {
                        chats[id]!.requests.removeAll { $0["id"] as? String == parts[2] }
                        chats[id]!.status = "working"
                    }
                }
            }
            return ok(["ok": true])
        }
        guard parts[1] == "sessions" else { return HTTPResponse(status: 404) }
        if parts.count == 2 { return ok(["sessions": lock.withLock { chats.values.sorted { $0.id < $1.id }.map(sessionJSON) }]) }
        let id = parts[2]
        guard lock.withLock({ chats[id] != nil }) else { return HTTPResponse(status: 404, body: Data(#"{"error":"no such session"}"#.utf8)) }
        if parts.count == 3 { return ok(["session": lock.withLock { sessionJSON(chats[id]!) }]) }
        switch (request.method, parts[3]) {
        case ("GET", "messages"):
            let q = Dictionary(uniqueKeysWithValues: query.split(separator: "&").compactMap { kv -> (String, String)? in
                let p = kv.split(separator: "=", maxSplits: 1).map(String.init)
                return p.count == 2 ? (p[0], p[1]) : nil
            })
            let limit = Int(q["limit"] ?? "") ?? 500
            let rows = lock.withLock { chats[id]!.rows }
            if let after = q["after"].flatMap(Int.init) {
                return ok(["messages": Array(rows.filter { ($0["seq"] as! Int) > after }.prefix(limit))])
            }
            let before = q["before"].flatMap(Int.init) ?? Int.max
            return ok(["messages": Array(rows.filter { ($0["seq"] as! Int) < before }.suffix(limit))])
        case ("GET", "pending"): return ok(["pending": lock.withLock { chats[id]!.pending }])
        case ("GET", "queue"): return ok(["queue": []])
        case ("GET", "requests"): return ok(["requests": lock.withLock { chats[id]!.requests }])
        case ("POST", "warm"): return ok([:])
        case ("POST", "messages"):
            let refuse = lock.withLock { () -> Bool in
                guard _failSends > 0 else { return false }
                _failSends -= 1
                return true
            }
            if refuse { throw TransportError.connectionRefused }
            let body = (try? JSONSerialization.jsonObject(with: request.body ?? Data())) as? [String: Any] ?? [:]
            lock.withLock { _recording = true }
            let queued = onSend(self, id, body["text"] as? String ?? "", SendMode(rawValue: body["mode"] as? String ?? "queue") ?? .queue)
            lock.withLock { _recording = false }
            return ok(["queued": queued])
        case ("GET", "ducklings"):
            guard parts.count == 5, let detail = lock.withLock({ chats[id]!.ducklingDetails[parts[4]] }) else { return HTTPResponse(status: 404) }
            return ok(detail)
        case ("POST", "interrupt"):
            modify(id) { $0.status = "cancelling" }
            return ok(["ok": true])
        default: return HTTPResponse(status: 404, body: Data(#"{"error":"not found"}"#.utf8))
        }
    }

    private func sessionJSON(_ c: Chat) -> [String: Any] {
        var j: [String: Any] = [
            "id": c.id, "cwd": "/tmp/work", "agent": c.agent, "title": "Chat \(c.id)", "model": "opus-5", "permissionMode": "default",
            "status": c.status, "createdAt": Self.iso(c.updatedAt), "updatedAt": Self.iso(c.updatedAt), "prunedThrough": 0,
            "background": ["count": c.background],
        ]
        if let d = c.ducklings { j["ducklings"] = d }
        if let t = c.lastTurnEndedAt { j["lastTurnEndedAt"] = Self.iso(t) }
        return j
    }

    static func iso(_ d: Date) -> String { d.formatted(Date.ISO8601FormatStyle()) }
}
