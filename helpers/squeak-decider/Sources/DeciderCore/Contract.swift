import Foundation

/// The helper's JSON contract. One request object in on stdin, one response object out on stdout, exit 0.
///
///   {"op":"embed","task":"...","texts":["...","..."]}
///     -> {"ok":true,"similarities":[0.4,0.1]}            (0..1 apiece, in the order of `texts`)
///   {"op":"decide","system":"...","prompt":"...","allowed":["1","2","hatch","wait"]}
///     -> {"ok":true,"choice":"2"}                        (`choice` is null when the model gave none of `allowed`)
///   anything the device cannot do (Apple Intelligence off, framework or assets missing)
///     -> {"ok":false,"unavailable":true,"reason":"..."}
///   a bad request
///     -> {"ok":false,"unavailable":false,"reason":"..."}
public struct Request: Codable, Equatable, Sendable {
    public var op: String
    public var task: String?
    public var texts: [String]?
    public var system: String?
    public var prompt: String?
    public var allowed: [String]?
}

public struct Response: Equatable, Sendable {
    public var ok: Bool
    public var unavailable: Bool?
    public var reason: String?
    public var similarities: [Double]?
    public var choice: String?
    /// True for a decide answer: `choice` is then written even when it is null.
    public var hasChoice = false

    public init(ok: Bool, unavailable: Bool? = nil, reason: String? = nil, similarities: [Double]? = nil, choice: String? = nil, hasChoice: Bool = false) {
        self.ok = ok
        self.unavailable = unavailable
        self.reason = reason
        self.similarities = similarities
        self.choice = choice
        self.hasChoice = hasChoice
    }

    public static func unavailable(_ reason: String) -> Response { Response(ok: false, unavailable: true, reason: reason) }
    public static func invalid(_ reason: String) -> Response { Response(ok: false, unavailable: false, reason: reason) }

    public func encoded() -> Data {
        var o: [String: Any] = ["ok": ok]
        if let unavailable { o["unavailable"] = unavailable }
        if let reason { o["reason"] = reason }
        if let similarities { o["similarities"] = similarities }
        if hasChoice { o["choice"] = choice ?? NSNull() }
        return (try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) ?? Data("{\"ok\":false}".utf8)
    }
}

/// What the device can do; the real one is Apple's, tests pass their own.
public protocol Backend: Sendable {
    /// Similarity per text, 0..1, or nil when no sentence embedding is available.
    func embed(task: String, texts: [String]) -> [Double]?
    /// The model's raw answer, or why it cannot answer (off, missing, failed).
    func generate(system: String, prompt: String) async -> Result<String, Unavailable>
}

public struct Unavailable: Error, Equatable, Sendable {
    public var reason: String
    public init(_ reason: String) { self.reason = reason }
}

public enum Handler {
    public static let maxTexts = 200

    public static func handle(_ data: Data, backend: Backend) async -> Response {
        guard let req = try? JSONDecoder().decode(Request.self, from: data) else { return .invalid("not a request") }
        switch req.op {
        case "embed":
            guard let task = req.task, let texts = req.texts, texts.count <= maxTexts else { return .invalid("embed needs task and texts") }
            if texts.isEmpty { return Response(ok: true, similarities: []) }
            guard let sims = backend.embed(task: task, texts: texts), sims.count == texts.count else {
                return .unavailable("no on-device sentence embedding")
            }
            return Response(ok: true, similarities: sims)
        case "decide":
            guard let prompt = req.prompt, let allowed = req.allowed, !allowed.isEmpty else { return .invalid("decide needs prompt and allowed") }
            switch await backend.generate(system: req.system ?? "", prompt: prompt) {
            case .failure(let u): return .unavailable(u.reason)
            case .success(let raw): return Response(ok: true, choice: pick(raw, allowed: allowed), hasChoice: true)
            }
        default:
            return .invalid("unknown op")
        }
    }

    /// The one allowed choice the answer names (punctuation, quotes and JSON braces around it ignored).
    /// Two different choices, prose with none, or nothing is no answer.
    public static func pick(_ raw: String, allowed: [String]) -> String? {
        let tokens = raw.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        let wanted = Set(allowed.map { $0.lowercased() })
        var found: String?
        for t in tokens where wanted.contains(t) {
            if let f = found, f != t { return nil }
            found = t
        }
        guard let found else { return nil }
        return allowed.first { $0.lowercased() == found }
    }

    public static func cosine(_ a: [Double], _ b: [Double]) -> Double {
        var dot = 0.0, na = 0.0, nb = 0.0
        for i in 0..<min(a.count, b.count) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
        guard na > 0, nb > 0 else { return 0 }
        return dot / (na.squareRoot() * nb.squareRoot())
    }
}
