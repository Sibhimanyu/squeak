// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SqueakIcons",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "SqueakIcons", targets: ["SqueakIcons"]),
        .executable(name: "lucide-sheet", targets: ["lucide-sheet"]),
        .executable(name: "tide-preview", targets: ["tide-preview"]),
    ],
    targets: [
        .target(name: "SqueakIcons"),
        .executableTarget(name: "lucide-sheet", dependencies: ["SqueakIcons"]),
        .executableTarget(name: "tide-preview", dependencies: ["SqueakIcons"]),
        .testTarget(name: "SqueakIconsTests", dependencies: ["SqueakIcons"]),
    ]
)
