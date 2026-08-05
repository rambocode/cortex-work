import Foundation

// Cortex_Helper 入口:按 argv[1] 分发子命令。one-shot 命令输出单行 JSON 后退出;
// events 为长驻模式,进 CFRunLoop 常驻直到 stdin 关闭或收到 quit。
// 协议详见各命令实现文件顶部注释。

let args = CommandLine.arguments
guard args.count >= 2 else {
    emitJSON(["ok": false, "error": "missing-command",
              "usage": "ax-capture | ax-activate <pid> | paste | ocr [pid] | screenshot [pid] | calendar"
                     + " | calendar-events <startMs> <endMs> | calendar-create | permissions | events"])
    exit(2)
}

switch args[1] {
case "ax-capture":
    runAXCapture()
case "ax-activate":
    guard args.count >= 3, let pid = pid_t(args[2]) else {
        emitJSON(["ok": false, "error": "missing-pid"])
        exit(2)
    }
    runAXActivate(pid: pid)
case "paste":
    runPaste() // 正文从 stdin 读一行，避免听写内容出现在 argv / ps。
case "ocr":
    let pid: pid_t? = args.count >= 3 ? pid_t(args[2]) : nil
    runOCR(pid: pid)
case "screenshot":
    let pid: pid_t? = args.count >= 3 ? pid_t(args[2]) : nil
    runScreenshot(pid: pid)
case "calendar":
    runCalendar()
case "calendar-events":
    // 时间窗经 argv 传 epoch 毫秒（解析在 TS 侧,见 CalendarEvents.swift 文件头说明）。
    guard args.count >= 4, let startMs = Int(args[2]), let endMs = Int(args[3]) else {
        emitJSON(["ok": false, "error": "bad-args"])
        exit(2)
    }
    runCalendarEvents(startMs: startMs, endMs: endMs)
case "calendar-create":
    runCalendarCreate() // 载荷经 stdin 读一行 JSON（避免标题/备注经 argv 被 ps 看见）
case "permissions":
    runPermissions()
case "events":
    runEvents() // 不返回:进入 runloop 常驻
default:
    emitJSON(["ok": false, "error": "unknown-command", "command": args[1]])
    exit(2)
}
