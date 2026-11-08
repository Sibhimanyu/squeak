import Foundation

/// What a control shows while the Mac has not answered a change yet. The new value is on screen at the touch
/// (and felt), the Mac's word settles it: kept on success, put back on a refusal. `Held` is the decision as data.
struct Held<Value: Equatable> {
    private(set) var value: Value?
    private var token = 0

    /// The value to draw: the one just chosen while it waits, else what the Mac says.
    func shown(_ real: Value) -> Value { value ?? real }

    /// A new choice; returns the token its outcome must present.
    mutating func hold(_ new: Value) -> Int { token += 1; value = new; return token }

    /// The Mac answered (or a fallback timer ran) for `token`. A newer choice is left alone.
    mutating func release(_ token: Int) { if token == self.token { value = nil } }

    /// The Mac's own value moved: whatever was held has been caught up with.
    mutating func caughtUp() { value = nil }
}
