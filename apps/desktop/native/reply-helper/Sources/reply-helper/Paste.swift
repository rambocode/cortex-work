import AppKit
import CoreGraphics
import Foundation

// paste <text>:把草稿写回目标输入框。移植自 ReplyClone AccessibilityBridge 的剪贴板粘贴路径。
// 关键约束:粘贴前多格式备份用户剪贴板、粘贴后恢复,绝不悄悄覆盖用户复制的内容;
// 用 defer 保证即使中途异常 / setString 失败,备份也会被还原。

/// 深拷贝当前剪贴板全部条目。NSPasteboardItem 不能跨 clearContents 复用,必须逐类型拷 data。
private func snapshotPasteboard(_ pasteboard: NSPasteboard) -> [NSPasteboardItem] {
    (pasteboard.pasteboardItems ?? []).map { item in
        let copy = NSPasteboardItem()
        for type in item.types {
            if let data = item.data(forType: type) {
                copy.setData(data, forType: type)
            }
        }
        return copy
    }
}

/// 用系统级 CGEvent 模拟 ⌘V。keycode:command=55、v=9。逐事件间隔 40ms,给目标应用留处理时间。
private func sendCommandV() {
    let source = CGEventSource(stateID: .hidSystemState)
    let commandKey: CGKeyCode = 55
    let vKey: CGKeyCode = 9

    let commandDown = CGEvent(keyboardEventSource: source, virtualKey: commandKey, keyDown: true)
    commandDown?.flags = .maskCommand
    commandDown?.post(tap: .cghidEventTap)
    usleep(40_000)

    let vDown = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true)
    vDown?.flags = .maskCommand
    vDown?.post(tap: .cghidEventTap)
    usleep(40_000)

    let vUp = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false)
    vUp?.flags = .maskCommand
    vUp?.post(tap: .cghidEventTap)
    usleep(40_000)

    let commandUp = CGEvent(keyboardEventSource: source, virtualKey: commandKey, keyDown: false)
    commandUp?.flags = []
    commandUp?.post(tap: .cghidEventTap)
}

/// paste <text>:备份剪贴板 → 写入草稿 → 模拟 ⌘V → 约 150ms 后恢复剪贴板。
func runPaste(text: String) {
    let pasteboard = NSPasteboard.general
    let savedItems = snapshotPasteboard(pasteboard)

    // defer 保证任何提前 return 后都能还原用户剪贴板(隐私 / 体验硬约束)。
    // 原始剪贴板非空 → 写回原内容;原始为空 → 必须 clearContents() 显式抹掉草稿。
    // 空分支不能省略:否则「刚重启 / 刚清空剪贴板」这一最常见场景下,line 62 写入的
    // AI 草稿正文会永久残留在系统剪贴板,对所有本地 app / 剪贴板历史管理器可读,违背隐私硬约束。
    defer {
        pasteboard.clearContents()
        if !savedItems.isEmpty {
            pasteboard.writeObjects(savedItems)
        }
    }

    pasteboard.clearContents()
    guard pasteboard.setString(text, forType: .string) else {
        emitJSON(["ok": false, "error": "clipboard-write-failed"])
        return
    }

    // 写入剪贴板与发送 ⌘V 之间稍等,确保目标应用读到的是新内容
    usleep(80_000)
    sendCommandV()

    // 等目标应用完成粘贴后再由 defer 恢复(~150ms,沿用任务约定)
    usleep(150_000)
    emitJSON(["ok": true])
}
