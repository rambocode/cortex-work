import AppKit
import CoreGraphics
import Foundation

// screenshot [pid]:截取指定或当前前台应用的可见主窗口，输出 PNG 的 base64。
// 输出保持在 stdout NDJSON 内，主进程负责落入受控临时文件再交给聊天图片管线，避免 renderer
// 直接获得系统截图能力。窗口选择复用 ScreenOCR 的 captureFrontmostWindow，确保 OCR 与视觉
// 上下文始终以同一前台窗口、同一去阴影边界为准。

/// 将截图编码为 PNG base64。CGImage 没有稳定的直接 PNG API，使用 AppKit 的 bitmap rep 可保留
/// 原始像素尺寸，避免 JPEG 重新压缩让文字/代码截图的细节变差。
func runScreenshot(pid: pid_t?) {
    guard CGPreflightScreenCaptureAccess() else {
        emitJSON(["ok": false, "error": "screen-not-authorized"])
        return
    }
    let targetPID = pid ?? NSWorkspace.shared.frontmostApplication?.processIdentifier
    guard let targetPID else {
        emitJSON(["ok": false, "error": "no-frontmost-app"])
        return
    }
    guard let image = captureFrontmostWindow(pid: targetPID) else {
        emitJSON(["ok": false, "error": "window-capture-failed"])
        return
    }
    guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
        emitJSON(["ok": false, "error": "png-encode-failed"])
        return
    }

    emitJSON([
        "ok": true,
        "pid": Int(targetPID),
        "mimeType": "image/png",
        "pngBase64": png.base64EncodedString()
    ])
}
