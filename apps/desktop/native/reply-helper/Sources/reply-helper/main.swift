import Foundation

// reply-helper 入口:按 argv[1] 分发子命令。one-shot 命令输出单行 JSON 后退出;
// events 为长驻模式,进 CFRunLoop 常驻直到 stdin 关闭或收到 quit。
// 协议详见各命令实现文件顶部注释。

let args = CommandLine.arguments
guard args.count >= 2 else {
    emitJSON(["ok": false, "error": "missing-command",
              "usage": "ax-capture | ax-activate <pid> | paste <text> | ocr [pid] | calendar | permissions | events"])
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
    guard args.count >= 3 else {
        emitJSON(["ok": false, "error": "missing-text"])
        exit(2)
    }
    runPaste(text: args[2])
case "ocr":
    let pid: pid_t? = args.count >= 3 ? pid_t(args[2]) : nil
    runOCR(pid: pid)
case "calendar":
    runCalendar()
case "permissions":
    runPermissions()
case "events":
    runEvents() // 不返回:进入 runloop 常驻
default:
    emitJSON(["ok": false, "error": "unknown-command", "command": args[1]])
    exit(2)
}
