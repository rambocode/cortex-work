import Foundation

/// 向 stdout 写一行 NDJSON。协议约定:每条命令响应 / 每个长驻事件占一行,
/// 写完立即 flush,保证父进程(Electron 主进程 helper-client)能实时逐行读取,
/// 不被 stdio 缓冲滞留。
func emitJSON(_ object: [String: Any]) {
    let data: Data
    if let encoded = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) {
        data = encoded
    } else {
        // 极端兜底:对象无法序列化时也要给父进程一条可解析的错误行,而非静默卡死
        data = Data("{\"ok\":false,\"error\":\"encode-failed\"}".utf8)
    }
    var line = data
    line.append(0x0A) // '\n'
    FileHandle.standardOutput.write(line)
}
