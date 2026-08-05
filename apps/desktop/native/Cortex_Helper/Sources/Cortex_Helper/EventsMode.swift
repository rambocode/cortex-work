import AppKit
import CoreGraphics
import Foundation

// events:长驻模式。用单个 CGEventTap 同时承载两件事:
//   1) 监听 flagsChanged 做全局修饰键手势判定(双击起草键 <0.35s → draft-gesture;
//      按住语音键 → voice-start / voice-end;按住听写组合键 → dictation-start / dictation-end)。
//      手势判定在原生侧完成,JS 只收高层事件。
//   2) intercept 开启期间吞掉候选气泡需要的四类键(Enter/Esc/←/→/Tab),转发为 key-event,
//      不让它们落入前台应用(否则微信里 Enter 会误发送)。
//
// 为什么用 CGEventTap 而非 NSEvent 全局监听:helper 是无 NSApplication 的裸 CLI,NSEvent 全局
// 监听依赖常规 App 的 runloop,不可靠;且吞键必须用 active tap(被动监听无法拦截)。
// tap 会被系统在超时 / 安全输入(密码框)后禁用,回调里检测到即重新启用(移植 CandidateKeyInterceptor 契约)。

/// 修饰键名 → CGEventFlags 单键位映射(与主进程下发的 config 字符串对齐)
private func flag(for name: String) -> CGEventFlags {
    modifierFlag(for: name) ?? .maskCommand
}

/// 仅接受主进程协议中约定的修饰键名。dictation 配置不能像 reply 旧配置那样静默回退到
/// Command，否则一条损坏设置可能意外吞掉用户的 Command 组合键。
private func modifierFlag(for name: String) -> CGEventFlags? {
    switch name {
    case "command": return .maskCommand
    case "option": return .maskAlternate
    case "control": return .maskControl
    case "shift": return .maskShift
    case "function": return .maskSecondaryFn
    default: return nil
    }
}

/// 吞键白名单:keycode → 语义名。仅这些键在 intercept 开启时被拦截转发。
private func interceptedKeyName(_ keyCode: Int64) -> String? {
    switch keyCode {
    case 36, 76: return "enter"   // 主键盘 Enter / 小键盘 Enter
    case 53: return "escape"
    case 123: return "left"
    case 124: return "right"
    case 48: return "tab"          // 「翻牌」
    default: return nil
    }
}

/// events 长驻模式的状态机与 tap 宿主。所有回调都在主线程 runloop 上执行,
/// stdin 命令经 DispatchQueue.main.async 回主线程改状态,故无需额外加锁。
final class EventsMode {
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?

    // 手势配置(可经 stdin config 命令覆盖);默认起草=⌘、语音=Fn
    private var draftFlag: CGEventFlags = .maskCommand
    private var voiceFlag: CGEventFlags = .maskSecondaryFn

    // 吞键开关:仅气泡激活期间由主进程下发 {"cmd":"intercept","on":true} 打开
    private var interceptOn = false

    // 手势判定的边沿状态(移植 HotkeyMonitor)
    private var lastDraftTap: Date?
    private var wasDraftDown = false
    private var wasVoiceDown = false
    private var voiceActive = false

    // 听写按住键独立于 reply 的 voice 手势：keyCode 为 nil 时是纯修饰键组合，非 nil 时
    // 是「修饰键 + ANSI 普通键」。active/heldKeyCode 必须分开保存，才能在 keyUp 可靠配对。
    private var dictationModifiers: [CGEventFlags] = []
    private var dictationKeyCode: Int64?
    private var dictationActive = false
    private var heldDictationKeyCode: Int64?

    /// 创建并启用 tap。返回 false 表示 tap 创建失败(通常为辅助功能未授权),
    /// 调用方据此让主进程降级到兜底 accelerator。
    func start() -> Bool {
        let mask = (1 << CGEventType.flagsChanged.rawValue)
            | (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.keyUp.rawValue)
        let unmanagedSelf = Unmanaged.passUnretained(self).toOpaque()
        eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: { _, type, event, refcon in
                guard let refcon else { return Unmanaged.passUnretained(event) }
                let mode = Unmanaged<EventsMode>.fromOpaque(refcon).takeUnretainedValue()
                // 超时 / 安全输入导致 tap 被系统禁用:重新启用,否则吞键与手势会静默失效
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    mode.reenable()
                    return Unmanaged.passUnretained(event)
                }
                return mode.handle(type: type, event: event)
            },
            userInfo: unmanagedSelf
        )
        guard let eventTap else { return false }
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        if let runLoopSource {
            CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        }
        CGEvent.tapEnable(tap: eventTap, enable: true)
        return true
    }

    /// tap 被系统禁用后重新启用
    func reenable() {
        guard let eventTap else { return }
        CGEvent.tapEnable(tap: eventTap, enable: true)
    }

    /// tap 主回调:flagsChanged 判定修饰键手势;dictation 的普通键组合在 keyDown/keyUp 配对并
    /// 吞掉;其余 keyDown 才交给候选气泡的 intercept 白名单处理。
    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .flagsChanged {
            handleFlags(event.flags)
            return Unmanaged.passUnretained(event)
        }
        if type == .keyDown {
            if handleDictationKeyDown(event) {
                return nil // 按住听写的触发键不应落入前台应用
            }
            if !interceptOn {
                return Unmanaged.passUnretained(event)
            }
            let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
            if let name = interceptedKeyName(keyCode) {
                emitJSON(["event": "key-event", "key": name])
                return nil // 吞掉,不落入前台应用
            }
        }
        if type == .keyUp, handleDictationKeyUp(event) {
            return nil // 与被吞掉的 keyDown 成对吞掉，避免前台收到孤立 keyUp
        }
        return Unmanaged.passUnretained(event)
    }

    /// 修饰键状态变化时的手势判定(移植 HotkeyMonitor.handleFlags):
    /// 起草键 0.35s 内两次按下 → draft-gesture;语音键按下/抬起 → voice-start/voice-end。
    private func handleFlags(_ flags: CGEventFlags) {
        let draftDown = flags.contains(draftFlag)
        let voiceDown = flags.contains(voiceFlag)

        if draftDown && !wasDraftDown && !voiceActive {
            let now = Date()
            if let last = lastDraftTap, now.timeIntervalSince(last) < 0.35 {
                emitJSON(["event": "draft-gesture"])
                lastDraftTap = nil
            } else {
                lastDraftTap = now
            }
        }
        // 超过双击窗口仍未等到第二次按下:清掉计时,避免与很久以后的下一次误配成双击
        if !draftDown, wasDraftDown, let last = lastDraftTap, Date().timeIntervalSince(last) > 0.35 {
            lastDraftTap = nil
        }

        if voiceDown && !wasVoiceDown && !voiceActive {
            voiceActive = true
            emitJSON(["event": "voice-start"])
        } else if !voiceDown && wasVoiceDown && voiceActive {
            voiceActive = false
            emitJSON(["event": "voice-end"])
        }

        wasDraftDown = draftDown
        wasVoiceDown = voiceDown

        // 纯修饰键组合没有 keyDown/keyUp 可配对：全部指定 flags 出现时开始，任一消失即结束。
        // 与 reply 的 voiceActive 状态刻意不共用，允许两套功能各自安全结束而不串状态。
        guard dictationKeyCode == nil, !dictationModifiers.isEmpty else { return }
        if allDictationModifiersDown(flags) {
            startDictation()
        } else {
            endDictation()
        }
    }

    /// 含普通 ANSI 键的听写组合在 keyDown 开始。CGEvent 的 autorepeat 会继续投递 keyDown，
    /// 因此 active/heldKeyCode 是必要去抖，避免一次长按反复触发录音开始。
    private func handleDictationKeyDown(_ event: CGEvent) -> Bool {
        guard let configuredKeyCode = dictationKeyCode,
              !dictationModifiers.isEmpty else {
            return false
        }
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        guard keyCode == configuredKeyCode, allDictationModifiersDown(event.flags) else {
            return false
        }
        if !dictationActive {
            dictationActive = true
            heldDictationKeyCode = keyCode
            emitJSON(["event": "dictation-start"])
        }
        return true
    }

    /// 只接受与启动时相同的 keyUp，避免用户在按住期间敲击其它键时提前结束听写。
    private func handleDictationKeyUp(_ event: CGEvent) -> Bool {
        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        guard dictationActive, heldDictationKeyCode == keyCode else { return false }
        heldDictationKeyCode = nil
        endDictation()
        return true
    }

    private func allDictationModifiersDown(_ flags: CGEventFlags) -> Bool {
        dictationModifiers.allSatisfy { flags.contains($0) }
    }

    private func startDictation() {
        guard !dictationActive else { return }
        dictationActive = true
        emitJSON(["event": "dictation-start"])
    }

    private func endDictation() {
        guard dictationActive else { return }
        dictationActive = false
        heldDictationKeyCode = nil
        emitJSON(["event": "dictation-end"])
    }

    // MARK: - stdin 命令

    /// 起后台线程逐行读 stdin(NDJSON 命令),解析后回主线程改状态。
    func startStdinReader() {
        Thread.detachNewThread { [weak self] in
            while let line = readLine(strippingNewline: true) {
                guard let self else { return }
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty,
                      let data = trimmed.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    continue
                }
                DispatchQueue.main.async { self.applyCommand(obj) }
            }
            // stdin 关闭(父进程退出):正常收尾
            DispatchQueue.main.async { exit(0) }
        }
    }

    /// 处理一条 stdin 命令:intercept 开关 / config 修饰键 / quit
    private func applyCommand(_ obj: [String: Any]) {
        guard let cmd = obj["cmd"] as? String else { return }
        switch cmd {
        case "intercept":
            interceptOn = (obj["on"] as? Bool) ?? false
        case "config":
            if let draft = obj["draft"] as? String { draftFlag = flag(for: draft) }
            if let voice = obj["voice"] as? String { voiceFlag = flag(for: voice) }
            if let dictation = obj["dictation"] as? [String: Any] {
                configureDictation(dictation)
            }
        case "quit":
            exit(0)
        default:
            break
        }
    }

    /// 应用按住听写配置。配置变更期间若正在录音，先发结束事件，避免旧键松开后无法配对而
    /// 让主进程停留在 recording 状态。无效配置一律禁用听写，绝不猜测用户意图。
    private func configureDictation(_ config: [String: Any]) {
        endDictation()
        guard let modifierNames = config["modifiers"] as? [String], !modifierNames.isEmpty else {
            dictationModifiers = []
            dictationKeyCode = nil
            return
        }
        let modifiers = modifierNames.compactMap(modifierFlag(for:))
        guard modifiers.count == modifierNames.count,
              Set(modifiers.map { $0.rawValue }).count == modifiers.count else {
            dictationModifiers = []
            dictationKeyCode = nil
            return
        }

        let keyCode: Int64?
        if let rawKeyCode = config["keyCode"], !(rawKeyCode is NSNull) {
            guard let number = rawKeyCode as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.rounded() == number.doubleValue,
                  number.int64Value >= 0 else {
                dictationModifiers = []
                dictationKeyCode = nil
                return
            }
            keyCode = number.int64Value
        } else {
            keyCode = nil
        }

        dictationModifiers = modifiers
        dictationKeyCode = keyCode
    }
}

/// events 子命令入口:建 tap → 起 stdin 读取 → 进 runloop 常驻。
/// tap 建不起来(未授权)时输出 tap-unavailable 并以非零码退出,供主进程降级。
func runEvents() {
    let mode = EventsMode()
    guard mode.start() else {
        emitJSON(["event": "tap-unavailable"])
        exit(3)
    }
    emitJSON(["event": "ready"])
    mode.startStdinReader()
    CFRunLoopRun()
}
