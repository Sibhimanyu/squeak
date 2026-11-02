// Catalyst Data Streams from plain Swift (no SDK): token from the relay, then URLSessionWebSocketTask.
// Usage: RELAY_URL=https://<domain>/server/squeak_relay RELAY_KEY=... streams [N]
// Protocol (read from @zcatalyst/datastreams 1.0.1 web-socket.js): see README.
import Foundation

let env = ProcessInfo.processInfo.environment
guard let relay = env["RELAY_URL"], let key = env["RELAY_KEY"] else { print("set RELAY_URL and RELAY_KEY"); exit(2) }
let rounds = CommandLine.arguments.dropFirst().first.flatMap(Int.init) ?? 10
// The JS client only accepts these hosts; do the same.
let allowedHosts: Set<String> = ["in1-dms.zoho.in", "in2-dms.zoho.in", "us4-dms.zoho.com", "us3-dms.zoho.com", "eu1-dms.zoho.eu", "eu2-dms.zoho.eu", "au1-dms.zoho.com.au", "au2-dms.zoho.com.au", "jp1-dms.zoho.jp", "jp2-dms.zoho.jp"]

func ms(_ a: UInt64, _ b: UInt64) -> Double { Double(b - a) / 1e6 }
func nowNs() -> UInt64 { DispatchTime.now().uptimeNanoseconds }
func randId(_ n: Int) -> String { String((0..<n).map { _ in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".randomElement()! }) }

func request(_ method: String, _ path: String, body: Data? = nil, headers: [String: String] = [:]) async throws -> (Data, HTTPURLResponse) {
    var r = URLRequest(url: URL(string: relay + path)!)
    r.httpMethod = method; r.httpBody = body
    for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
    let (d, resp) = try await URLSession.shared.data(for: r)
    return (d, resp as! HTTPURLResponse)
}

// 1. token
let conn = "swift-" + randId(10)
let (tokData, tokResp) = try await request("POST", "/token", body: try JSONSerialization.data(withJSONObject: ["connectionName": conn]), headers: ["x-relay-key": key])
guard tokResp.statusCode == 200, let tokJSON = try JSONSerialization.jsonObject(with: tokData) as? [String: Any], let token = tokJSON["token"] as? [String: Any],
      let host = (token["url"] as? String)?.lowercased(), let zuid = token["wss-id"] as? String, let tkey = token["key"] as? String, allowedHosts.contains(host)
else { print("token failed:", tokResp.statusCode, String(data: tokData, encoding: .utf8) ?? ""); exit(1) }
print("token ok, host:", host)

// 2. connect. Query values are plain (zuid and key contain only URL-safe characters).
var comps = URLComponents(); comps.scheme = "wss"; comps.host = host; comps.path = "/wsconnect"
comps.queryItems = [URLQueryItem(name: "prd", value: "CY"), URLQueryItem(name: "zuid", value: zuid), URLQueryItem(name: "key", value: tkey)]
let task = URLSession.shared.webSocketTask(with: comps.url!)
let connectStart = nowNs()
task.resume()

func send(_ obj: Any) async throws { try await task.send(.string(String(data: try JSONSerialization.data(withJSONObject: obj), encoding: .utf8)!)) }

// keepalive: the JS client sends the bare text "-" every 15 s and {"type":"con","value":"ping"} every 60 s
let pinger = Task { while !Task.isCancelled { try? await Task.sleep(nanoseconds: 15_000_000_000); try? await task.send(.string("-")) } }

actor Waiter { var cont: CheckedContinuation<Void, Never>?; func set(_ c: CheckedContinuation<Void, Never>) { cont = c }; func fire() { cont?.resume(); cont = nil } }
let waiter = Waiter()
var lastStreamingId = ""
var latencies: [Double] = []
var sentAt: UInt64 = 0
var subscribed = false
let channelFragment = "channels/"

let reader = Task {
    while !Task.isCancelled {
        let msg: URLSessionWebSocketTask.Message
        do { msg = try await task.receive() } catch { print("receive error:", error); return }
        guard case .string(let s) = msg else { continue }
        if s.isEmpty { continue } // pong
        guard let arr = (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [[String: Any]], let first = arr.first else { print("unparsed:", s.prefix(120)); continue }
        switch first["mtype"] as? String {
        case "0": // auth success {sid, uid}
            print("connected in", String(format: "%.0f ms", ms(connectStart, nowNs())), first["msg"] ?? "")
            try? await send(["type": "con", "value": "subscribe", "streamingId": "0"])
            subscribed = true; await waiter.fire()
        case "650": // data
            for item in arr {
                guard let m = item["msg"] as? [String: Any], let d = m["data"] as? [String: Any] else { continue }
                if (m["opr"] as? String) == "event", let sid = d["streamingId"] as? String {
                    lastStreamingId = sid
                    if sentAt != 0 { latencies.append(ms(sentAt, nowNs())); sentAt = 0 }
                    print("event", sid, d["data"] ?? "")
                    try? await send(["type": "ack", "streamingId": sid]) // required before the next message is delivered
                    await waiter.fire()
                }
            }
        case "-5": print("auth failed (3000)"); exit(1)
        case "-11": print("session expired / closing:", first["reason"] ?? "")
        case "-1": print("switch url:", first["msg"] ?? "")
        default: print("other mtype:", first["mtype"] ?? "?", s.prefix(160))
        }
    }
}

// wait for subscribe
await withCheckedContinuation { c in Task { await waiter.set(c) } }
try await Task.sleep(nanoseconds: 1_500_000_000)

// 3. measure: PUT through the relay, time until the notice arrives
let ch = randId(32)
func docPath(_ d: String) -> String { "/doc?path=" + "channels/\(ch)/state/\(d)".addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-_"))).unsafelyUnwrapped }
for i in 0..<rounds {
    sentAt = nowNs()
    async let wait: Void = withCheckedContinuation { c in Task { await waiter.set(c) } }
    let body = try JSONSerialization.data(withJSONObject: ["box": "swift-\(i)"])
    _ = try await request("PUT", docPath("notice"), body: body)
    let timeout = Task { try await Task.sleep(nanoseconds: 10_000_000_000); print("no notice in 10 s"); exit(1) }
    await wait; timeout.cancel()
    try await Task.sleep(nanoseconds: 400_000_000)
}
_ = try await request("DELETE", docPath("notice"))
try? await send(["type": "con", "value": "unsubscribe"]) // always before closing
try await Task.sleep(nanoseconds: 800_000_000)
pinger.cancel(); reader.cancel(); task.cancel(with: .normalClosure, reason: nil)
let s = latencies.sorted()
if !s.isEmpty { print(String(format: "swift PUT->notice ms: n=%d p50=%.0f p95=%.0f", s.count, s[s.count / 2], s[min(s.count - 1, Int(Double(s.count) * 0.95))])) }
