import EventKit
import Foundation

// calendar-events / calendar-create:供 capabilities/calendar 的 MCP 工具使用,让 Agent 在会话中
// 查询任意时间窗的日程、并在用户确认后创建日程。
//
// 与同目录 CalendarBusy.swift 的 `calendar` 子命令是两套契约,刻意不合并:
//   · `calendar` 服务于快捷回复,固定未来 3 天、只出非全天的忙碌区间、时间用 ISO8601 字符串,
//     且 reply/controller.ts 已逐字段依赖它。参数化它等于同时改动一条已稳定的路径,收益为零。
//   · 本文件面向模型,需要任意时间窗、全天事件、标题/地点,时间一律用 epoch 毫秒。
//
// 【为什么时间进出都用 epoch 毫秒而不是 ISO8601】
// 本 Swift 包没有 test target(Package.swift 只有一个 executableTarget),Swift 侧任何逻辑都无法
// 单测。所以把全部时间解析、时区推断、相对时间处理放在 TS 侧(capabilities/calendar/time.ts,
// 有 vitest 覆盖),Swift 只做 Date(timeIntervalSince1970:) 这一步不可能出错的换算。
// ISO8601 在进程边界上有「有无 offset / 有无小数秒 / 是否 date-only」三重歧义,跨语言各写一遍
// 解析器必然漂移。
//
// 【授权取舍,沿用 CalendarBusy.swift 的既定判断】
// helper 不主动触发日历 TCC 授权弹窗——裸 SPM 可执行文件无 Info.plist 的 NSCalendars*
// UsageDescription,调用 requestFullAccessToEvents 会因缺描述而崩溃;授权引导统一由主应用侧
// (有完整 Info.plist)负责。未授权一律返回结构化错误。
//
// 【读必须硬判 fullAccess】
// macOS 14 起有 writeOnly 授权档:只能写、不能读。write-only 下 store.events(matching:) 返回的是
// **空数组而不是报错**——把它当成「已授权」的话,用户会看到「你这周没有任何日程」这种静默假成功。

// 事件条数上限:超出即截断并置 truncated,避免一次查询把整个上下文窗口灌满。
private let MAX_EVENTS = 500

/// 当前日历授权档,输出给 TS 侧做门控与授权引导分支。
/// 取值:notDetermined / restricted / denied / writeOnly / full
func calendarAccessString() -> String {
    let status = EKEventStore.authorizationStatus(for: .event)
    switch status {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    default: break
    }
    if #available(macOS 14, *) {
        if status == .fullAccess { return "full" }
        if status == .writeOnly { return "writeOnly" }
        return "denied"
    } else {
        // macOS 13 及更早只有 .authorized,语义等同 full（无 write-only 档）。
        return status == .authorized ? "full" : "denied"
    }
}

private func ms(_ date: Date) -> Int {
    return Int(date.timeIntervalSince1970 * 1000)
}

/// calendar-events <startEpochMs> <endEpochMs>:查询时间窗内全部事件（含全天）。需 full access。
func runCalendarEvents(startMs: Int, endMs: Int) {
    let access = calendarAccessString()
    guard access == "full" else {
        // 与 calendar-not-authorized 分开:write-only 的引导动作不同（只能去系统设置改成「完全访问」，
        // macOS 不会为已决策的应用二次弹窗），TS 侧据此给不同的文案。
        let code = access == "writeOnly" ? "calendar-read-requires-full-access" : "calendar-not-authorized"
        emitJSON(["ok": false, "error": code, "access": access])
        return
    }

    let store = EKEventStore()
    let start = Date(timeIntervalSince1970: Double(startMs) / 1000)
    let end = Date(timeIntervalSince1970: Double(endMs) / 1000)
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let matched = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }
    let truncated = matched.count > MAX_EVENTS
    let events: [[String: Any]] = matched.prefix(MAX_EVENTS).map { event in
        var item: [String: Any] = [
            "id": event.eventIdentifier ?? "",
            "title": event.title ?? "(无标题)",
            "startMs": ms(event.startDate),
            "endMs": ms(event.endDate),
            "allDay": event.isAllDay,
            "calendar": event.calendar?.title ?? ""
        ]
        if let location = event.location, !location.isEmpty {
            item["location"] = location
        }
        return item
    }

    emitJSON([
        "ok": true,
        "access": access,
        "timeZone": TimeZone.current.identifier,
        "windowStartMs": startMs,
        "windowEndMs": endMs,
        "truncated": truncated,
        "events": events
    ])
}

/// calendar-create:从 stdin 读一行 JSON 载荷创建日程。需 full 或 writeOnly。
///
/// 载荷走 stdin 而非 argv:事件标题与备注是用户私密内容,argv 对同机任意进程经 `ps` 可见。
/// (同目录的 `paste <text>` 已有这个泄漏,不应再扩大。)
func runCalendarCreate() {
    let access = calendarAccessString()
    guard access == "full" || access == "writeOnly" else {
        emitJSON(["ok": false, "error": "calendar-not-authorized", "access": access])
        return
    }

    guard let line = readLine(strippingNewline: true),
          let data = line.data(using: .utf8),
          let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        emitJSON(["ok": false, "error": "bad-payload", "access": access])
        return
    }
    guard let title = payload["title"] as? String, !title.isEmpty,
          let startMs = payload["startMs"] as? Int,
          let endMs = payload["endMs"] as? Int else {
        emitJSON(["ok": false, "error": "bad-payload", "access": access])
        return
    }

    let store = EKEventStore()
    let event = EKEvent(eventStore: store)
    event.title = title
    event.startDate = Date(timeIntervalSince1970: Double(startMs) / 1000)
    event.endDate = Date(timeIntervalSince1970: Double(endMs) / 1000)
    event.isAllDay = (payload["allDay"] as? Bool) ?? false
    if let notes = payload["notes"] as? String, !notes.isEmpty { event.notes = notes }
    if let location = payload["location"] as? String, !location.isEmpty { event.location = location }
    if let minutes = payload["alarmMinutesBefore"] as? Int {
        event.addAlarm(EKAlarm(relativeOffset: TimeInterval(-minutes * 60)))
    }

    // 目标日历。注意 write-only 档下 calendars(for:) 不可用（那是读操作），此时忽略调用方指定的
    // 日历名直接用默认日历——否则会在能写的情况下因为「查不到日历」而白白失败。
    var target: EKCalendar? = store.defaultCalendarForNewEvents
    if access == "full", let wanted = payload["calendar"] as? String, !wanted.isEmpty {
        let found = store.calendars(for: .event).first {
            $0.title == wanted && $0.allowsContentModifications
        }
        guard let found else {
            emitJSON(["ok": false, "error": "no-writable-calendar", "access": access,
                      "message": "找不到可写入的日历「\(wanted)」"])
            return
        }
        target = found
    }
    guard let calendar = target else {
        emitJSON(["ok": false, "error": "no-writable-calendar", "access": access,
                  "message": "系统没有配置默认日历"])
        return
    }
    event.calendar = calendar

    do {
        try store.save(event, span: .thisEvent, commit: true)
        emitJSON([
            "ok": true,
            "access": access,
            "id": event.eventIdentifier ?? "",
            "calendar": calendar.title,
            "startMs": ms(event.startDate),
            "endMs": ms(event.endDate),
            "allDay": event.isAllDay
        ])
    } catch {
        emitJSON(["ok": false, "error": "save-failed", "access": access,
                  "message": error.localizedDescription])
    }
}
