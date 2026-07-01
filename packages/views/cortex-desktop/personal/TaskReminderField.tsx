// 任务提醒录入控件（U11）。日期 + 时:分选择 → 写 TaskMeta.reminder.at（绝对 epoch ms）。
// 到点由 main 侧 tasks-reminder-scheduler 投递一次原生桌面通知（需在设置里开「内部原生通知」opt-in，
// 否则调度器不建 Cron、提醒静默）。复用 ScheduleEditor 的本地日期↔epoch 手感
//（hour/minute <select> + dateStrToAt/toDateStr）；这里字段少，helper 就近内联而非跨文件导出。
import { useState } from "react";
import { useUpdateTask } from "@cortex-work/core/personal/tasks";
import { useDesktopBridge } from "@cortex-work/core";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import type { TaskMeta } from "@cortex-work/core/desktop/types";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const pad = (n: number) => String(n).padStart(2, "0");
// Date → <input type="date"> 用的本地 YYYY-MM-DD。
const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => toDateStr(new Date());
// 本地「日期串 + 时:分」→ 绝对 epoch ms（与 ScheduleEditor.dateStrToAt 同构）。
// noUncheckedIndexedAccess 下解构元素为 number | undefined，三段都兜底（dateStr 恒为合法 YYYY-MM-DD）。
function dateStrToAt(dateStr: string, hour: number, minute: number): number {
  const [y, mo, da] = dateStr.split("-").map(Number);
  return new Date(y || 1970, (mo || 1) - 1, da || 1, hour, minute, 0, 0).getTime();
}
function fmtReminder(ts: number): string {
  const d = new Date(ts);
  return `${toDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function TaskReminderField({ task }: { task: TaskMeta }) {
  const updateTask = useUpdateTask();
  // 通知 opt-in 门控（U11）：提醒由 main 调度器投递，但门控在「内部原生通知」总开关，默认关。
  // 用户设了提醒却没开该开关 → 静默不弹（常见困惑「设置了提醒没有提醒」）。此处显式提示 + 一键开启。
  // 仅桌面端有该门控（web 无原生通知调度）；toggle 经 store:save 钩子实时同步给 main 调度器（无需重启）。
  const bridge = useDesktopBridge();
  const pushSettings = usePersonalStore((s) => s.pushSettings);
  const setPushSettings = usePersonalStore((s) => s.setPushSettings);
  const notifOff = !!bridge && !pushSettings.internal?.enabled;
  const enableNotif = () => setPushSettings({ internal: { ...(pushSettings.internal ?? {}), enabled: true } });
  const at = task.reminder?.at;
  // 编辑维度：日期默认今天（或已设提醒的日期），时刻默认 09:00（或已设提醒的时刻）。
  const [dateStr, setDateStr] = useState(() => (at != null ? toDateStr(new Date(at)) : todayStr()));
  const [hour, setHour] = useState(() => (at != null ? new Date(at).getHours() : 9));
  const [minute, setMinute] = useState(() => (at != null ? new Date(at).getMinutes() : 0));

  // 写提醒时清掉旧 firedAt：重设提醒要能再次触发（firedAt 是「只触发一次」的幂等闸门，U11）。
  const commit = (ds: string, h: number, m: number) =>
    updateTask.mutate({ id: task.id, patch: { reminder: { at: dateStrToAt(ds, h, m), firedAt: undefined } } });
  const clear = () => updateTask.mutate({ id: task.id, patch: { reminder: undefined } });

  return (
    <span className="pw-task-reminder">
      <input
        type="date"
        className="pw-task-meta-date"
        value={dateStr}
        min={todayStr()}
        onChange={(e) => {
          setDateStr(e.target.value);
          commit(e.target.value, hour, minute);
        }}
      />
      <select
        className="pw-task-meta-select"
        value={hour}
        onChange={(e) => {
          const v = Number(e.target.value);
          setHour(v);
          commit(dateStr, v, minute);
        }}
      >
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {pad(h)}
          </option>
        ))}
      </select>
      <span className="pw-task-reminder-sep">:</span>
      <select
        className="pw-task-meta-select"
        value={minute}
        onChange={(e) => {
          const v = Number(e.target.value);
          setMinute(v);
          commit(dateStr, hour, v);
        }}
      >
        {MINUTES.map((m) => (
          <option key={m} value={m}>
            {pad(m)}
          </option>
        ))}
      </select>
      {at != null && <span className="pw-task-meta-ro">{fmtReminder(at)}</span>}
      {at != null && (
        <button className="pw-task-meta-btn" title="清除提醒" onClick={clear}>
          清除
        </button>
      )}
      {/* opt-in 关时的提示：设了提醒也不会弹，给一键开启入口（直击「设置了提醒没有提醒」）。 */}
      {notifOff && (
        <span className="pw-task-notif-warn">
          未开启系统通知，提醒不会弹出
          <button type="button" className="pw-task-notif-enable" onClick={enableNotif}>
            开启
          </button>
        </span>
      )}
    </span>
  );
}
