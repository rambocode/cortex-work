// swift-tools-version: 6.2
// Cortex_Helper:Cortex Desktop「快捷回复」功能的 macOS 原生伴生二进制。
// 承载 Electron 做不到的系统能力(辅助功能读写 / CGEventPost ⌘V / Vision OCR /
// EventKit 日历 / 全局修饰键手势与条件吞键),经 stdin/stdout NDJSON 协议与主进程通信。
//
// 语言模式固定 v5:本 helper 大量使用 AppKit / CGEventTap C 回调 / 跨线程 stdin 读取,
// 属系统集成层,Swift 6 严格并发会对这些成熟惯例(Unmanaged refcon、主线程 runloop 共享
// 可变状态)报大量误伤;为忠实移植 ReplyClone 契约、避免无收益的并发重写,显式用 v5。

import PackageDescription

let package = Package(
    name: "Cortex_Helper",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(
            name: "Cortex_Helper",
            targets: ["Cortex_Helper"]
        )
    ],
    targets: [
        .executableTarget(
            name: "Cortex_Helper",
            path: "Sources/Cortex_Helper",
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ],
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("Vision"),
                .linkedFramework("EventKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("Speech")
            ]
        )
    ]
)
