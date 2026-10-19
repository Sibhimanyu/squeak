// swift-tools-version: 6.0
import PackageDescription

// How an agent's message is set on screen, shared by Squeak for Mac and Squeak
// for iPhone: a safe Markdown parser (values only) and one SwiftUI renderer.
let package = Package(
    name: "SqueakMarkup",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "SqueakMarkup", targets: ["SqueakMarkup"]),
    ],
    dependencies: [
        .package(path: "../icons"),
    ],
    targets: [
        .target(name: "SqueakMarkup", dependencies: [.product(name: "SqueakIcons", package: "icons")]),
        .testTarget(name: "SqueakMarkupTests", dependencies: ["SqueakMarkup"]),
    ],
    swiftLanguageModes: [.v6]
)
