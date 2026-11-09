import Foundation

/// A list that holds still while you look at it. Items arrive newest first; the order shown is the one from when
/// the screen opened, so a chat that keeps working does not jump to the top under a finger about to tap it. A new
/// item goes in at the top; one that left is dropped. The screen forgets the order when it opens again or is pulled
/// to refresh, and then shows newest first. Pure: items and the last order in, the order to show out.
enum StableOrder {
    static func arrange<T>(_ newestFirst: [T], previous: [String], key: (T) -> String) -> [T] {
        guard !previous.isEmpty else { return newestFirst }
        var byKey: [String: T] = [:]
        for item in newestFirst where byKey[key(item)] == nil { byKey[key(item)] = item }
        let known = Set(previous)
        let fresh = newestFirst.filter { !known.contains(key($0)) }
        var seen = Set<String>()
        let kept = previous.compactMap { id -> T? in
            guard seen.insert(id).inserted else { return nil }
            return byKey[id]
        }
        return fresh + kept
    }
}
