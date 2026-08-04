import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import EventKit
import Foundation
import Speech

// permissions:一次性查询五项 TCC 权限状态。移植自 ReplyClone PermissionCenter,但纯只读——
// 只查状态(不触发任何授权弹窗),避免裸 CLI 缺 Info.plist 描述时崩溃。
// 授权请求由主进程侧(node-mac-permissions,U4)或打开系统设置(U9)完成。

/// 三态字符串,与 core 侧权限模型对齐:granted / denied / notDetermined
private func stateString(granted: Bool, determined: Bool = true) -> String {
    if granted { return "granted" }
    return determined ? "denied" : "notDetermined"
}

/// permissions:输出 accessibility / screen / calendar / microphone / speech 五项状态
func runPermissions() {
    // 辅助功能:AXIsProcessTrusted 只读、不弹窗(无 kAXTrustedCheckOptionPrompt)
    let accessibility = AXIsProcessTrusted()

    // 屏幕录制:Preflight 只读检查
    let screen = CGPreflightScreenCaptureAccess()

    // 日历:macOS 14+ 用 fullAccess/writeOnly 判定
    let calStatus = EKEventStore.authorizationStatus(for: .event)
    let calendarGranted: Bool
    let calendarDetermined: Bool
    if #available(macOS 14, *) {
        calendarGranted = calStatus == .fullAccess || calStatus == .writeOnly
    } else {
        calendarGranted = calStatus == .authorized
    }
    calendarDetermined = calStatus != .notDetermined

    // 麦克风
    let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
    let micGranted = micStatus == .authorized
    let micDetermined = micStatus != .notDetermined

    // 语音识别
    let speechStatus = SFSpeechRecognizer.authorizationStatus()
    let speechGranted = speechStatus == .authorized
    let speechDetermined = speechStatus != .notDetermined

    emitJSON([
        "ok": true,
        "accessibility": stateString(granted: accessibility),
        "screen": stateString(granted: screen),
        "calendar": stateString(granted: calendarGranted, determined: calendarDetermined),
        // calendarAccess:日历五态细分（notDetermined/restricted/denied/writeOnly/full）。
        // 只加键、不改上面的 calendar 三态,parseHelperPermissions 忽略未知键,旧调用方零影响。
        //
        // 为什么必须由 helper 出这个值:node-mac-permissions@2.5.0 的 EventAuthStatus 只 switch 了
        // Authorized/Denied/Restricted,把 EKAuthorizationStatusWriteOnly(4) 落进 default 分支报
        // "not determined"。日历三态若以它为准,write-only 会被误判成「还没问过」,导致
        // 「去授权」按钮点了完全没反应（既不弹窗也不开设置面板）。
        "calendarAccess": calendarAccessString(),
        "microphone": stateString(granted: micGranted, determined: micDetermined),
        "speech": stateString(granted: speechGranted, determined: speechDetermined)
    ])
}
