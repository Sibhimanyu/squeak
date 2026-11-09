import Foundation

/// Fuzzy matching for the palette: a query term matches a text when it is a substring or, failing that, a
/// subsequence of it. Higher is better; nil is no match. Everything is compared folded (case, diacritics).
public enum PaletteMatch {
    public static func fold(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }

    /// `term` and `text` must already be folded. A substring beats a subsequence; a match at the start, or at the
    /// start of a word, beats one inside a word; consecutive letters and an early start beat scattered ones.
    public static func score(_ term: String, in text: String) -> Int? {
        guard !term.isEmpty else { return 0 }
        let t = Array(text), q = Array(term)
        guard !t.isEmpty else { return nil }
        if let r = text.range(of: term) {
            let at = text.distance(from: text.startIndex, to: r.lowerBound)
            var s = 1000 - min(at, 200)
            if at == 0 { s += 300 } else if isBoundary(t, at) { s += 150 }
            if t.count == q.count { s += 200 }
            return s
        }
        guard q.count >= 2 else { return nil }
        var qi = 0, run = 0, s = 0, last = -1
        for (i, ch) in t.enumerated() where qi < q.count && ch == q[qi] {
            if last == i - 1 { run += 1; s += 8 + run * 4 } else { run = 0; s += 4 }
            if isBoundary(t, i) { s += 12 }
            if qi == 0 { s -= min(i, 40) }
            last = i
            qi += 1
        }
        guard qi == q.count else { return nil }
        // Scattered across a long text is a weak hit; keep it below any substring hit.
        return max(1, min(s, 400) - (t.count - q.count) / 4)
    }

    private static func isBoundary(_ t: [Character], _ i: Int) -> Bool {
        guard i > 0 else { return true }
        let p = t[i - 1]
        return !(p.isLetter || p.isNumber)
    }
}
