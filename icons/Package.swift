// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SqueakIcons",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "SqueakIcons", targets: ["SqueakIcons"]),
        .executable(name: "lucide-sheet", targets: ["lucide-sheet"]),
    ],
    targets: [
        .target(name: "SqueakIcons"),
        .executableTarget(name: "lucide-sheet", dependencies: ["SqueakIcons"]),
        .testTarget(name: "SqueakIconsTests", dependencies: ["SqueakIcons"]),
    ]
)
