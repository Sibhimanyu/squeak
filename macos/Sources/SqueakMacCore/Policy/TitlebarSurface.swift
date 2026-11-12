/// Which views inside the window's titlebar container paint a surface of their own (a background, a material, a
/// scroll-edge pocket, the separator). The top row is Squeak's own, so these are hidden; the buttons stay.
public enum TitlebarSurface {
    public static func paintsBackground(className: String) -> Bool {
        let n = className
        if n.contains("NSTitlebarContainerView") { return false }
        return n.contains("Background") || n.contains("VisualEffect") || n.contains("ScrollPocket")
            || n.contains("Separator") || n.contains("ScrollEdge")
    }
}
