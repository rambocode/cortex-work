import EventKit
import Foundation

// calendar:读未来 3 天非全天事件的忙碌区间。移植自 ReplyClone CalendarReader,但拆分职责——
// helper 只输出忙碌区间 + 查询窗口,空闲间隙计算(≥30min、≤8 段、HH:mm-HH:mm 摘要)交给
// packages/core/reply 的 calendar-slots(U1)。
//
// 关键取舍:helper 不主动触发日历 TCC 授权弹窗——未授权直接返回结构化错误。
// 原因:裸 SPM 可执行文件无 Info.plist 的 NSCalendars*UsageDescription,调用
// requestFullAccessToEvents 会因缺描述而崩溃;授权引导统一由主应用侧(有完整 Info.plist)负责。

/// calendar:输出未来 3 天忙碌区间(ISO8601)。日历未授权时返回结构化错误。
func runCalendar() {
    let status = EKEventStore.authorizationStatus(for: .event)
    let authorized: Bool
    if #available(macOS 14, *) {
        authorized = status == .fullAccess || status == .writeOnly
    } else {
        authorized = status == .authorized
    }
    guard authorized else {
        emitJSON(["ok": false, "error": "calendar-not-authorized"])
        return
    }

    let store = EKEventStore()
    let now = Date()
    let end = Calendar.current.date(byAdding: .day, value: 3, to: now) ?? now.addingTimeInterval(86_400 * 3)
    let predicate = store.predicateForEvents(withStart: now, end: end, calendars: nil)
    let events = store.events(matching: predicate).filter { !$0.isAllDay }

    let formatter = ISO8601DateFormatter()
    let busy: [[String: Any]] = events.map { event in
        [
            "start": formatter.string(from: event.startDate),
            "end": formatter.string(from: event.endDate),
            "title": event.title ?? "Busy"
        ]
    }

    emitJSON([
        "ok": true,
        "windowStart": formatter.string(from: now),
        "windowEnd": formatter.string(from: end),
        "busy": busy
    ])
}
