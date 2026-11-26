import Foundation

/// "Powered by Aarav\u{2019}s MacBook \u{00B7} Flotilla": the mark on a thread a member runs with their own agent on their own Mac.
public enum PondPoweredBy {
    public static func line(nest: String?) -> String {
        let n = nest?.trimmingCharacters(in: .whitespaces) ?? ""
        return n.isEmpty ? "Powered by their Mac \u{00B7} Flotilla" : "Powered by \(n) \u{00B7} Flotilla"
    }
}
