// 任务重复录入控件（U12/U14）。对齐设计稿并扩展：单位（不重复/分钟/小时/天/周/月，分/时与天/周/月同级）
// + 间隔 N + 自定义（周：选星期几；月：月中的一天网格 / 周中的第 N 个星期几）。写 TaskMeta.repeat。
// 滚动语义在纯逻辑 taskRepeat.ts：分/时锚提醒时刻按间隔顺延（需有提醒）；天/周/月顺延日期（需日期锚点）。
// 本控件只发 patch；无对应锚点时给「需设…才会滚动」提示（对齐 store 侧 canRoll 门槛）。
import { useUpdateTask } from "@cortex-work/core/personal/tasks";
import type { TaskMeta, TaskRepeat } from "@cortex-work/core/desktop/types";

// select 承载「单位」（含「不重复」空档）；数量由前面的 N 输入承载，读作「每 N 周」。分/时为子日单位，与天/周/月同级。
const UNITS: Array<{ v: "" | TaskRepeat["kind"]; label: string }> = [
  { v: "", label: "不重复" },
  { v: "minutely", label: "分钟" },
  { v: "hourly", label: "小时" },
  { v: "daily", label: "天" },
  { v: "weekly", label: "周" },
  { v: "monthly", label: "月" },
];
const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"]; // index = 0..6（0=周日）
const ORDINALS: Array<{ v: NonNullable<TaskRepeat["ordinal"]>; label: string }> = [
  { v: "1", label: "第一个" },
  { v: "2", label: "第二个" },
  { v: "3", label: "第三个" },
  { v: "4", label: "第四个" },
  { v: "5", label: "第五个" },
  { v: "last", label: "最后的" },
];
const WEEKDAY_FULL = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

export function TaskRepeatField({ task }: { task: TaskMeta }) {
  const updateTask = useUpdateTask();
  const r = task.repeat;
  const cur = r?.kind ?? "";
  const interval = r?.interval ?? 1;
  const custom = !!r?.custom;
  const weekdays = r?.weekdays ?? [];
  const monthMode = r?.monthMode ?? "day";
  const monthDays = r?.monthDays ?? [];
  const ordinal = r?.ordinal ?? "1";
  const weekday = r?.weekday ?? 1;

  // 合并式改写 repeat（仅在已有 repeat 时）；kind 切换单独处理。
  const patchR = (partial: Partial<TaskRepeat>) => {
    if (r) updateTask.mutate({ id: task.id, patch: { repeat: { ...r, ...partial } } });
  };
  // 切单位：空 → 清 repeat（结束重复）；否则保留现有细则 + 设 kind/interval。
  const setKind = (v: string) => {
    if (!v) updateTask.mutate({ id: task.id, patch: { repeat: undefined } });
    else updateTask.mutate({ id: task.id, patch: { repeat: { ...(r ?? {}), kind: v as TaskRepeat["kind"], interval } } });
  };
  const setInterval = (raw: string) => patchR({ interval: Math.max(1, parseInt(raw, 10) || 1) });
  // 开自定时，monthly 需把 monthMode 落进模型——否则 monthMode=undefined，滚动逻辑不认 monthDays（静默回退简单月重复）。
  const toggleCustom = () => {
    const next = !custom;
    patchR(next && cur === "monthly" && r?.monthMode == null ? { custom: true, monthMode: "day" } : { custom: next });
  };
  // 切「周中的一天」tab 时把 ordinal/weekday 默认值一并落库（UI 用 ?? 默认显示，不写库则滚动逻辑视为缺配置而回退）。
  const setMonthWeekdayMode = () =>
    patchR({ monthMode: "weekday", ordinal: r?.ordinal ?? "1", weekday: r?.weekday ?? 1 });
  const toggleWeekday = (wd: number) =>
    patchR({ weekdays: weekdays.includes(wd) ? weekdays.filter((x) => x !== wd) : [...weekdays, wd].sort((a, b) => a - b) });
  // 点选月中日时一并落 monthMode:"day"——避免「切单位遗留 custom 但缺 monthMode」时选日不生效（review major）。
  const toggleMonthDay = (dd: number | "last") =>
    patchR({
      monthMode: "day",
      monthDays: monthDays.some((x) => x === dd) ? monthDays.filter((x) => x !== dd) : [...monthDays, dd],
    });

  const isSubDay = cur === "minutely" || cur === "hourly";
  const isDateKind = cur === "daily" || cur === "weekly" || cur === "monthly";
  // 滚动锚点门槛：分/时需提醒；天/周/月需截止/延后日期。缺锚点时提示（否则完成会落正常 done，不滚动）。
  const needsReminder = isSubDay && task.reminder?.at == null;
  const needsDate = isDateKind && !task.dueDate && !task.deferDate;

  return (
    <div className="pw-task-repeat">
      <div className="pw-task-repeat-row">
        {cur && <span className="pw-task-repeat-lead">每</span>}
        {cur && (
          <input
            className="pw-task-meta-input pw-task-repeat-n"
            type="number"
            min={1}
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          />
        )}
        <select className="pw-task-meta-select pw-task-repeat-unit" value={cur} onChange={(e) => setKind(e.target.value)}>
          {UNITS.map((k) => (
            <option key={k.v} value={k.v}>
              {k.label}
            </option>
          ))}
        </select>
      </div>

      {/* 自定开关：仅 周/月 有意义（分/时/天无「自定」概念）。 */}
      {(cur === "weekly" || cur === "monthly") && (
        <label className="pw-task-repeat-custom-toggle">
          <input type="checkbox" checked={custom} onChange={toggleCustom} />
          自定
        </label>
      )}

      {/* 自定 · 周：选星期几（可多选）。 */}
      {custom && cur === "weekly" && (
        <div className="pw-task-weekday-chips">
          {WEEKDAY_LABELS.map((lab, i) => (
            <button
              key={i}
              type="button"
              className={`pw-task-weekday-chip${weekdays.includes(i) ? " is-on" : ""}`}
              onClick={() => toggleWeekday(i)}
            >
              {lab}
            </button>
          ))}
        </div>
      )}

      {/* 自定 · 月：月中的一天（网格 + 最后一天）/ 周中的第 N 个星期几。 */}
      {custom && cur === "monthly" && (
        <div className="pw-task-month-custom">
          <div className="pw-task-month-tabs">
            <button
              type="button"
              className={`pw-task-month-tab${monthMode === "day" ? " is-on" : ""}`}
              onClick={() => patchR({ monthMode: "day" })}
            >
              月中的一天
            </button>
            <button
              type="button"
              className={`pw-task-month-tab${monthMode === "weekday" ? " is-on" : ""}`}
              onClick={setMonthWeekdayMode}
            >
              周中的一天
            </button>
          </div>
          {monthMode === "day" ? (
            <div className="pw-task-monthday-grid">
              {Array.from({ length: 31 }, (_, i) => i + 1).map((dd) => (
                <button
                  key={dd}
                  type="button"
                  className={`pw-task-monthday${monthDays.some((x) => x === dd) ? " is-on" : ""}`}
                  onClick={() => toggleMonthDay(dd)}
                >
                  {dd}
                </button>
              ))}
              <button
                type="button"
                className={`pw-task-monthday pw-task-monthday-last${monthDays.some((x) => x === "last") ? " is-on" : ""}`}
                onClick={() => toggleMonthDay("last")}
              >
                最后一天
              </button>
            </div>
          ) : (
            <div className="pw-task-month-weekday">
              <select
                className="pw-task-meta-select"
                value={ordinal}
                onChange={(e) => patchR({ ordinal: e.target.value as NonNullable<TaskRepeat["ordinal"]> })}
              >
                {ORDINALS.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.label}
                  </option>
                ))}
              </select>
              <select
                className="pw-task-meta-select"
                value={weekday}
                onChange={(e) => patchR({ weekday: Number(e.target.value) })}
              >
                {WEEKDAY_FULL.map((lab, i) => (
                  <option key={i} value={i}>
                    {lab}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}

      {needsReminder && <span className="pw-task-meta-ro">需设提醒才会滚动</span>}
      {needsDate && <span className="pw-task-meta-ro">需设截止/延后日期才会滚动</span>}
    </div>
  );
}
