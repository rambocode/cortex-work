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

private func axStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? String
}

private func axBoolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
        return nil
    }
    return value as? Bool
}

private func hasRangeBoundsAttribute(_ element: AXUIElement) -> Bool {
    var namesRef: CFArray?
    guard AXUIElementCopyParameterizedAttributeNames(element, &namesRef) == .success,
          let names = namesRef as? [String] else {
        return false
    }
    return names.contains(kAXBoundsForRangeParameterizedAttribute as String)
}

private func rect(from frame: [String: Double]?) -> CGRect? {
    guard let frame,
          let x = frame["x"],
          let y = frame["y"],
          let width = frame["width"],
          let height = frame["height"],
          x.isFinite,
          y.isFinite,
          width.isFinite,
          height.isFinite,
          width > 0,
          height > 0 else {
        return nil
    }
    return CGRect(x: x, y: y, width: width, height: height)
}

private struct InputAnchorCandidate {
    let anchor: [String: Double]
    let score: Double
}

/// 微信等应用有时不给 focused/caret，但 AX 树里仍有真正输入框。这里主动寻找底部输入控件，
/// 输出“输入首行”锚点（height=0），供主进程按候选窗语义放到它下方。
private func inputAnchor(from frame: [String: Double], windowRect: CGRect?) -> InputAnchorCandidate? {
    guard let rect = rect(from: frame), rect.width >= 80, rect.height >= 14 else { return nil }
    if let windowRect {
        guard windowRect.intersects(rect) else { return nil }
        // 输入框通常位于聊天窗口下半部分；过滤顶部搜索框、标题栏、消息列表里的文本元素。
        guard rect.midY >= windowRect.minY + windowRect.height * 0.52 else { return nil }
        guard rect.height <= max(260, windowRect.height * 0.45) else { return nil }
    }

    let topInset = min(12, max(0, rect.height * 0.12))
    let anchor = [
        "x": Double(rect.minX),
        "y": Double(rect.minY + topInset),
        "width": Double(rect.width),
        "height": 0.0
    ]
    let windowRelativeY = windowRect.map { (rect.maxY - $0.minY) / max(1, $0.height) } ?? rect.maxY / 1000
    let widthScore = min(rect.width, 900) / 900
    let heightPenalty = rect.height > 180 ? 0.2 : 0
    return InputAnchorCandidate(anchor: anchor, score: windowRelativeY * 10 + widthScore - heightPenalty)
}

private func isLikelyInputElement(_ element: AXUIElement) -> Bool {
    let role = axStringAttribute(element, kAXRoleAttribute)
    let subrole = axStringAttribute(element, kAXSubroleAttribute)
    if role == "AXTextArea" || role == "AXTextField" || role == "AXComboBox" {
        return true
    }
    if subrole == "AXSecureTextField" {
        return true
    }
    // 一些非标准 AX 实现只暴露 editable + range bounds，不给标准 role。
    return axBoolAttribute(element, "AXEditable") == true && hasRangeBoundsAttribute(element)
}

private func collectInputAnchors(
    from element: AXUIElement,
    depth: Int,
    windowRect: CGRect?,
    out: inout [InputAnchorCandidate]
) {
    guard depth < 8 else { return }
    if isLikelyInputElement(element), let candidate = inputAnchor(from: axFrame(of: element) ?? [:], windowRect: windowRect) {
        out.append(candidate)
    }
    var childrenRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
          let children = childrenRef as? [AXUIElement] else {
        return
    }
    for child in children.prefix(100) {
        collectInputAnchors(from: child, depth: depth + 1, windowRect: windowRect, out: &out)
    }
}

private func inputAnchorFrame(
    focusedElement: AXUIElement?,
    focusedWindow: AXUIElement?,
    windowFrame: [String: Double]?
) -> [String: Double]? {
    let windowRect = rect(from: windowFrame)
    var candidates: [InputAnchorCandidate] = []
    if let focusedElement {
        collectInputAnchors(from: focusedElement, depth: 0, windowRect: windowRect, out: &candidates)
    }
    if candidates.isEmpty, let focusedWindow {
        collectInputAnchors(from: focusedWindow, depth: 0, windowRect: windowRect, out: &candidates)
    }
    return candidates.max(by: { $0.score < $1.score })?.anchor
}

/// 读取焦点文本元素的光标(文本插入点)屏幕矩形——输入法候选窗的定位方式:
/// AXSelectedTextRange → kAXBoundsForRangeParameterizedAttribute。坐标系同 axFrame(主屏左上原点)。
/// 纯光标(空选区)常见返回零宽矩形,属正常;取不到或全零垃圾值返回 nil,
/// 由主进程按 caret → 输入框 frame → 窗口 frame → 鼠标 的链条兜底。
private func axCaretFrame(of element: AXUIElement) -> [String: Double]? {
    var rangeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
          let rangeValue = rangeRef else {
        return nil
    }
    var boundsRef: CFTypeRef?
    guard AXUIElementCopyParameterizedAttributeValue(
        element,
        kAXBoundsForRangeParameterizedAttribute as CFString,
        rangeValue,
        &boundsRef
    ) == .success, let boundsValue = boundsRef else {
        return nil
    }
    var rect = CGRect.zero
    guard AXValueGetValue((boundsValue as! AXValue), .cgRect, &rect) else { return nil }
    // 部分应用对空光标返回全零矩形——视为无效(真实光标至少有行高;(0,0) 顶角零尺寸不可能是插入点)。
    if rect.origin.x == 0, rect.origin.y == 0, rect.size.width == 0, rect.size.height == 0 { return nil }
    return ["x": Double(rect.origin.x), "y": Double(rect.origin.y), "width": Double(rect.size.width), "height": Double(rect.size.height)]
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

/// CGWindowList 兜底读取指定 pid 的前台可见窗口 bounds(屏幕左上原点、point,同 axFrame 坐标系)。
/// 微信等 AX 支持不完整的应用常取不到 AX windowFrame,但 kCGWindowBounds 不需要屏幕录制权限、
/// 总能拿到——供气泡窗锚定兜底,避免退化到「鼠标位置」而远离真实输入框。
func cgWindowBounds(pid: pid_t) -> [String: Double]? {
    guard let info = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID
    ) as? [[String: Any]] else {
        return nil
    }
    // 与 ScreenOCR 的窗口筛选判据一致:layer 0(普通窗口)且非全透明,取 z 序最前一个
    let window = info.first { entry in
        guard let ownerPID = entry[kCGWindowOwnerPID as String] as? pid_t,
              let layer = entry[kCGWindowLayer as String] as? Int,
              let alpha = entry[kCGWindowAlpha as String] as? Double else {
            return false
        }
        return ownerPID == pid && layer == 0 && alpha > 0
    }
    guard let dict = window?[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: dict) else {
        return nil
    }
    return ["x": Double(rect.origin.x), "y": Double(rect.origin.y), "width": Double(rect.size.width), "height": Double(rect.size.height)]
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

    // 焦点窗口标题：IM（微信等）的会话窗口标题通常即当前对话对象名（如「张玲玲-财务」），
    // 供主进程解析「对方」身份注入 prompt；取不到 / 与应用名无区分时由主进程侧过滤。
    var titleRef: CFTypeRef?
    let windowTitle: String =
        focusedWindow.flatMap { win -> String? in
            AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleRef) == .success
                ? (titleRef as? String) : nil
        } ?? ""

    // 焦点窗口 frame：微信等 AX 不完整、取不到焦点输入框 frame 时，气泡窗改用窗口 frame 兜底锚定
    // （聊天 app 输入框在窗口底部，比锚到鼠标位置贴合得多）。坐标系同 focusedFrame（左上原点）。
    // AX 窗口 frame 也取不到（微信常见）→ 再兜底 CGWindowList bounds，尽量不退化到鼠标位置。
    let windowFrame = focusedWindow.flatMap(axFrame(of:)) ?? cgWindowBounds(pid: pid)

    let merged = mergeContext(windowText: windowText, focusedText: focusedText)

    // 显式标注 [String: Any] 并分步赋值：混合类型（String/Bool/NSNull/Int/嵌套字典）的大字典字面量
    // 会让 Swift 类型推断超时（"unable to type-check in reasonable time"），显式类型可消除该开销。
    var payload: [String: Any] = [
        "ok": true,
        "text": merged,
        "meaningful": meaningfulConversation(merged),
        "windowTitle": windowTitle,
        "pid": Int(pid),
        "appName": app.localizedName ?? "",
        "appBundleId": app.bundleIdentifier ?? ""
    ]
    payload["focusedFrame"] = focusedFrame ?? NSNull()
    // 光标插入点矩形(输入法式精确锚点):优先于 focusedFrame 供气泡锚定,元素 frame 漂移时仍指向真实输入位置。
    payload["caretFrame"] = focusedElement.flatMap(axCaretFrame(of:)) ?? NSNull()
    // 微信等 AX 不完整场景：主动扫描窗口 AX 树里的底部文本输入控件，输出输入首行锚点。
    payload["inputAnchorFrame"] = inputAnchorFrame(
        focusedElement: focusedElement,
        focusedWindow: focusedWindow,
        windowFrame: windowFrame
    ) ?? NSNull()
    payload["windowFrame"] = windowFrame ?? NSNull()
    emitJSON(payload)
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
