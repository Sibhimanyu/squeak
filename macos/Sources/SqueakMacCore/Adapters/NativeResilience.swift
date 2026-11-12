import Foundation

/// Calls the host once per opening of a chat: the same chat re-entering (a task restarting on a state change) is one
/// opening, another chat or a long gap (the host's runner idles out) is a new one.
public struct WarmGate: Sendable {
    public static let reopenAfter: TimeInterval = 30 * 60
    private var last: (key: SessionKey, at: Date)?

    public init() {}

    public mutating func shouldWarm(_ key: SessionKey, now: Date = Date()) -> Bool {
        if let last, last.key == key, now.timeIntervalSince(last.at) < Self.reopenAfter { return false }
        last = (key, now)
        return true
    }
}

/// Whether a native chat's `needs_*` notification is posted: never for the chat on screen in the front window, and
/// never twice for one request.
public struct NativeNotifyGate: Sendable {
    private var seen: Set<String> = []
    private var order: [String] = []

    public init() {}

    /// `requestId` is the host's request (or any stable identity of the ask); `frontmost` is "this chat is the one the
    /// frontmost, visible conversation window shows". A suppressed event is not remembered, so the same request
    /// posts if the person navigates away and it is still waiting.
    public mutating func admit(requestId: String?, frontmost: Bool) -> Bool {
        if frontmost { return false }
        guard let requestId else { return true }
        if seen.contains(requestId) { return false }
        seen.insert(requestId); order.append(requestId)
        if order.count > 200 { seen.remove(order.removeFirst()) }
        return true
    }
}

/// The one live "Retrying…" line from the host's `system/api_retry` rows.
public enum NativeRetry {
    /// "Retrying… attempt 4 of 10", from one row's payload (`attempt`, `max_retries`); without a number, just "Retrying…".
    public static func line(_ payload: NativeJSON) -> String {
        let attempt = payload["attempt"]?.int
        let max = payload["max_retries"]?.int ?? payload["maxRetries"]?.int
        switch (attempt, max) {
        case let (a?, m?): return "Retrying… attempt \(a) of \(m)"
        case let (a?, nil): return "Retrying… attempt \(a)"
        default: return "Retrying…"
        }
    }
}

/// Error rows say what happened in a fixed sentence, never a JSON body.
public enum NativeErrorText {
    /// The host records a pressed Stop as `{type:"error",content:"aborted by user"}`: not a failure.
    public static func isStop(_ raw: String) -> Bool { raw.lowercased().contains("aborted by user") }

    public static func sentence(_ raw: String) -> String {
        if isStop(raw) { return "Stopped" }
        let t = raw.lowercased()
        if t.contains("credit balance") || t.contains("insufficient_quota") || t.contains("billing") || t.contains("payment required") {
            return "Out of credit. Add credit to the account this chat uses, then send again."
        }
        if t.contains("rate_limit") || t.contains("rate limit") || t.contains("usage limit") || t.contains("429") || t.contains("too many requests") {
            return "Hit a rate limit. It will work again when the limit resets."
        }
        if t.contains("overloaded") || t.contains("529") {
            return "The model is overloaded right now. Try again in a moment."
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // A raw JSON body (an API error envelope) is never shown.
        if trimmed.hasPrefix("{") || trimmed.hasPrefix("[") || trimmed.contains("\"type\":\"error\"") {
            return "The request failed. Try again."
        }
        return raw
    }
}
