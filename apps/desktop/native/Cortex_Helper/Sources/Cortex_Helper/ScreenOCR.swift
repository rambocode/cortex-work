import AppKit
import CoreGraphics
import Foundation
import Vision

// ocr [pid]:截取目标应用前台窗口并 Vision OCR,输出带归一化坐标的文本块。
// 移植自 ReplyClone ScreenTextReader,但只负责「截屏 + OCR + 输出原始块」;
// 对话版面重建(剔侧栏 / 分说话人 / 合并)由 packages/core/reply 的纯逻辑(U1)在 JS 侧完成。
// 坐标契约:Vision 原生归一化坐标系(0~1,原点左下),原样透传,换算责任在消费侧。

/// 找到指定 pid 的前台可见窗口(layer 0、alpha>0)并截图为 CGImage
private func captureFrontmostWindow(pid: pid_t) -> CGImage? {
    guard let info = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] else {
        return nil
    }
    let window = info.first { entry in
        guard let ownerPID = entry[kCGWindowOwnerPID as String] as? pid_t,
              let layer = entry[kCGWindowLayer as String] as? Int,
              let alpha = entry[kCGWindowAlpha as String] as? Double else {
            return false
        }
        return ownerPID == pid && layer == 0 && alpha > 0
    }
    guard let windowNumber = window?[kCGWindowNumber as String] as? UInt32 else {
        return nil
    }
    // boundsIgnoreFraming 去掉窗口阴影边距(实测缺它时图像每边多 ~34pt)——
    // 否则 Vision 归一化坐标相对「含阴影画布」,与 kCGWindowBounds(无阴影)换算屏幕坐标会系统性偏移,
    // 气泡锚定 / 会话区分栏判定都被拖偏。
    return CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(windowNumber), [.bestResolution, .boundsIgnoreFraming])
}

/// ocr [pid]:未传 pid 时取当前前台应用。屏幕录制未授权时返回结构化错误(不弹窗、不崩溃)。
func runOCR(pid: pid_t?) {
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

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.recognitionLanguages = ["zh-Hans", "en-US"]

    let handler = VNImageRequestHandler(cgImage: image)
    do {
        try handler.perform([request])
    } catch {
        emitJSON(["ok": false, "error": "ocr-failed", "detail": error.localizedDescription])
        return
    }

    let blocks: [[String: Any]] = (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        let box = observation.boundingBox
        return [
            "text": text,
            "boundingBox": [
                "x": Double(box.origin.x),
                "y": Double(box.origin.y),
                "width": Double(box.size.width),
                "height": Double(box.size.height)
            ]
        ]
    }

    // 被截窗口的屏幕 bounds(左上原点、point):AX 拿不到任何 frame 时,主进程用它锚定气泡窗,
    // 避免退化到鼠标位置(复用 AXCapture 的 CGWindowList 兜底,坐标系契约一致)。
    var payload: [String: Any] = ["ok": true, "blocks": blocks]
    payload["windowBounds"] = cgWindowBounds(pid: targetPID) ?? NSNull()
    emitJSON(payload)
}
