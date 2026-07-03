import AppKit
import ApplicationServices
import Foundation

// AX 捕获 / 目标应用激活。移植自 ReplyClone AccessibilityBridge,但改造成无状态 one-shot:
// 单次进程调用只做「读取当前前台应用文本 + 焦点输入框 frame + pid/bundleId」,不保留跨调用的
// AX 元素引用(元素引用无法跨进程存活)。回填时的目标锁定改由主进程记住 pid,再调 ax-activate。

/// 解析用户真正在操作的前台应用。helper 作为无 UI 子进程被 spawn,自身从不成为前台,
/// 故 frontmostApplication 即为真实目标(微信 / 邮件等);仍排除极端情况下自身为前台。
private func targetApp() -> NSRunningApplication? {
    let selfPID = ProcessInfo.processInfo.processIdentifier
    if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != selfPID {
        return front
    }
    if let owner = NSWorkspace.shared.menuBarOwningApplication, owner.processIdentifier != selfPID {
        return owner
    }
    return nil
}

/// 输入框占位符等噪声,判定「像不像对话」时需要先排除
private let placeholders = [
    "输入文字",
    "按住Fn使用语音输入",
    "输入文字，或按住Fn使用语音输入",
    "Type a message"
]

private func isPlaceholder(_ text: String) -> Bool {
    placeholders.contains { text.contains($0) }
}

/// 读取单个 AX 元素的文本:依次尝试 value / title / description,取首个非空
private func axText(from element: AXUIElement) -> String {
    for attribute in [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute] {
        var value: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
           let string = value as? String,
           !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return string
        }
    }
    return ""
}

/// 读取元素在屏幕坐标系中的 frame(AX 原点在主屏左上、y 向下)。
/// 该 frame 供气泡窗锚定使用,坐标系换算责任在渲染侧(U6 geometry),此处原样输出。
private func axFrame(of element: AXUIElement) -> [String: Double]? {
    var positionRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let positionValue = positionRef,
          let sizeValue = sizeRef else {
        return nil
    }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue((positionValue as! AXValue), .cgPoint, &point),
          AXValueGetValue((sizeValue as! AXValue), .cgSize, &size) else {
        return nil
    }
    return ["x": Double(point.x), "y": Double(point.y), "width": Double(size.width), "height": Double(size.height)]
}

/// 深度优先收集元素子树的所有文本。深度上限 8、每层子节点上限 80——
/// 微信等应用的 AX 树极深且宽,不设上限会在超大窗口上卡死;这两个常量沿用 ReplyClone 契约。
private func collectText(from element: AXUIElement, depth: Int) -> [String] {
    guard depth < 8 else { return [] }
    var result: [String] = []
    let own = axText(from: element)
    if !own.isEmpty {
        result.append(own)
    }
    var childrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
          let children = childrenRef as? [AXUIElement] else {
        return result
    }
    for child in children.prefix(80) {
        result.append(contentsOf: collectText(from: child, depth: depth + 1))
    }
    return result
}

/// 合并窗口全文与焦点元素文本:焦点文本已被窗口文本包含 / 为占位符 / 为空时,只用窗口文本;
/// 否则把焦点输入框内容单独标注追加,便于模型区分「已输入的半截草稿」。
private func mergeContext(windowText: String, focusedText: String) -> String {
    let cleanedFocused = focusedText.trimmingCharacters(in: .whitespacesAndNewlines)
    let cleanedWindow = windowText.trimmingCharacters(in: .whitespacesAndNewlines)
    if cleanedFocused.isEmpty || isPlaceholder(cleanedFocused) || cleanedWindow.contains(cleanedFocused) {
        return cleanedWindow
    }
    return [cleanedWindow, "输入框：\(cleanedFocused)"]
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
}

/// 启发式判断一段文本「像不像一段对话」。主进程据此决定是否需要降级到 OCR。
/// 判据沿用 ReplyClone:足够长、非占位符、且含换行 / 冒号(说话人分隔)或整体较长。
private func meaningfulConversation(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count >= 12 else { return false }
    if isPlaceholder(trimmed) { return false }
    return trimmed.contains("\n") || trimmed.contains("：") || trimmed.contains(":") || trimmed.count >= 30
}

/// ax-capture:读取前台应用对话文本 + 焦点输入框 frame + pid + appBundleId。
/// 辅助功能未授权时返回结构化错误(而非崩溃),由主进程走 OCR 降级或引导授权。
func runAXCapture() {
    guard AXIsProcessTrusted() else {
        emitJSON(["ok": false, "error": "accessibility-not-authorized"])
        return
    }
    guard let app = targetApp() else {
        emitJSON(["ok": false, "error": "no-frontmost-app"])
        return
    }
    let pid = app.processIdentifier
    let axApp = AXUIElementCreateApplication(pid)

    // 焦点元素(可能取不到——微信等 AX 支持不完整);frame 只在拿到元素时有值
    var focusedRef: CFTypeRef?
    let focusedElement: AXUIElement? =
        AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute as CFString, &focusedRef) == .success
        ? (focusedRef as! AXUIElement) : nil
    let focusedText = focusedElement.map(axText(from:)) ?? ""
    let focusedFrame = focusedElement.flatMap(axFrame(of:))

    // 焦点窗口全文
    var windowRef: CFTypeRef?
    let focusedWindow: AXUIElement? =
        AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &windowRef) == .success
        ? (windowRef as! AXUIElement) : nil
    let windowText = focusedWindow.map { collectText(from: $0, depth: 0).joined(separator: "\n") } ?? ""

    let merged = mergeContext(windowText: windowText, focusedText: focusedText)

    emitJSON([
        "ok": true,
        "text": merged,
        "meaningful": meaningfulConversation(merged),
        "focusedFrame": focusedFrame ?? NSNull(),
        "pid": Int(pid),
        "appName": app.localizedName ?? "",
        "appBundleId": app.bundleIdentifier ?? ""
    ])
}

/// ax-activate <pid>:把捕获时的目标应用重新激活到前台,为随后的 paste ⌘V 铺垫。
/// one-shot 无法保留跨进程的 AX 窗口 / 元素引用,故只按 pid 激活应用(足以让 ⌘V 落到其焦点框)。
func runAXActivate(pid: pid_t) {
    guard let app = NSRunningApplication(processIdentifier: pid) else {
        emitJSON(["ok": false, "error": "app-not-running"])
        return
    }
    app.activate()
    emitJSON(["ok": true])
}
