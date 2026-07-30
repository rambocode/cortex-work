// 定时规则编辑器：每小时 / 每天 / 工作日 / 每周 / 自定义 cron,具体到时:分。
// kind 用 SegmentedRadio（按显示文案匹配,故维护 label↔kind 映射）;自定义 cron
// 经 bridge.automationValidateCron 做合法性 + nextRun 预览（真相以 main 调度为准）。

import { useEffect, useState } from "react";
import { SegmentedRadio } from "@cortex-work/ui/controls/SegmentedRadio";
import { useDesktopBridge } from "@cortex-work/core";
import type { ScheduleSpec } from "@cortex-work/core";

const KIND_LABEL: Record<ScheduleSpec["kind"], string> = {
  hourly: "每小时",
  daily: "每天",
  weekdays: "工作日",
  weekly: "每周",
  cron: "自定义",
  once: "一次性",
};
const KIND_ORDER: ScheduleSpec["kind"][] = ["hourly", "daily", "weekdays", "weekly", "cron", "once"];
const KIND_OPTIONS = KIND_ORDER.map((k) => KIND_LABEL[k]);
const labelToKind = (label: string): ScheduleSpec["kind"] =>
  KIND_ORDER.find((k) => KIND_LABEL[k] === label) ?? "daily";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const pad = (n: number) => String(n).padStart(2, "0");

// 把 Date 取本地年月日格式化为 <input type="date"> 用的 YYYY-MM-DD。
const toDateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// 今天与明天的本地日期串：min 用今天兜 future,默认值用明天。
const todayStr = () => toDateStr(new Date());
const tomorrowStr = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toDateStr(d);
};
// 把本地「日期串 + 时 + 分」组装为绝对时刻 epoch ms。
// once 存绝对时刻,与任务 timezone 无关;UI 兜 future,引擎宽容(见 validateScheduleSpec)。
function dateStrToAt(dateStr: string, hour: number, minute: number): number {
  // noUncheckedIndexedAccess 下解构元素为 number | undefined,三段都兜底(dateStr 恒为合法 YYYY-MM-DD,兜底仅满足类型)。
  const [y, mo, da] = dateStr.split("-").map(Number);
  return new Date(y || 1970, (mo || 1) - 1, da || 1, hour, minute, 0, 0).getTime();
}

function fmtPreview(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ScheduleEditor({
  value,
  onChange,
}: {
  value: ScheduleSpec;
  onChange: (s: ScheduleSpec) => void;
}) {
  const bridge = useDesktopBridge();
  // 各维度局部缓存:切 kind 时保留已填值,改善体验。
  const [hour, setHour] = useState(() =>
    value.kind === "once" ? new Date(value.at).getHours() : "hour" in value ? value.hour : 9,
  );
  const [minute, setMinute] = useState(() =>
    value.kind === "once"
      ? new Date(value.at).getMinutes()
      : value.kind !== "cron" && "minute" in value
        ? value.minute
        : 0,
  );
  const [weekday, setWeekday] = useState(() => (value.kind === "weekly" ? value.weekday : 1));
  const [expr, setExpr] = useState(() => (value.kind === "cron" ? value.expression : "0 9 * * *"));
  // once 额外的「日期」维度;默认明天,编辑已有 once 时从 at 反解本地日期。
  const [dateStr, setDateStr] = useState(() =>
    value.kind === "once" ? toDateStr(new Date(value.at)) : tomorrowStr(),
  );
  const [preview, setPreview] = useState<{ ok: boolean; text: string } | null>(null);

  const kind = value.kind;

  const emit = (next: Partial<{ kind: ScheduleSpec["kind"]; hour: number; minute: number; weekday: number; expr: string; date: string }>) => {
    const k = next.kind ?? kind;
    const h = next.hour ?? hour;
    const m = next.minute ?? minute;
    const wd = next.weekday ?? weekday;
    const e = next.expr ?? expr;
    const ds = next.date ?? dateStr;
    let spec: ScheduleSpec;
    switch (k) {
      case "hourly":
        spec = { kind: "hourly", minute: m };
        break;
      case "daily":
        spec = { kind: "daily", hour: h, minute: m };
        break;
      case "weekdays":
        spec = { kind: "weekdays", hour: h, minute: m };
        break;
      case "weekly":
        spec = { kind: "weekly", weekday: wd, hour: h, minute: m };
        break;
      case "cron":
        spec = { kind: "cron", expression: e };
        break;
      case "once":
        // once 把本地「日期 + 时:分」组装为绝对 epoch ms。
        spec = { kind: "once", at: dateStrToAt(ds, h, m) };
        break;
    }
    onChange(spec);
  };

  // 自定义 cron:防抖校验 + nextRun 预览。
  useEffect(() => {
    if (kind !== "cron" || !bridge?.automationValidateCron) {
      setPreview(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      bridge
        .automationValidateCron!(expr.trim())
        .then((v) => {
          if (!alive) return;
          if (v.ok) setPreview({ ok: true, text: v.nextRun ? `下次：${fmtPreview(v.nextRun)}` : "有效" });
          else setPreview({ ok: false, text: v.error ?? "无效的 cron 表达式" });
        })
        .catch(() => alive && setPreview({ ok: false, text: "校验失败" }));
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [kind, expr, bridge]);

  return (
    <div className="pw-auto-sched">
      <SegmentedRadio
        label="频率"
        value={KIND_LABEL[kind]}
        options={KIND_OPTIONS}
        onChange={(label) => emit({ kind: labelToKind(label) })}
      />

      <div className="pw-auto-sched-row">
        {kind === "once" ? (
          <label className="pw-set-field pw-auto-inline">
            <span className="pw-set-lbl">日期</span>
            <input
              type="date"
              className="pw-set-input"
              value={dateStr}
              min={todayStr()}
              onChange={(e) => {
                setDateStr(e.target.value);
                emit({ date: e.target.value });
              }}
            />
          </label>
        ) : null}

        {kind === "weekly" ? (
          <label className="pw-set-field pw-auto-inline">
            <span className="pw-set-lbl">星期</span>
            <select
              className="pw-set-input"
              value={weekday}
              onChange={(e) => {
                const v = Number(e.target.value);
                setWeekday(v);
                emit({ weekday: v });
              }}
            >
              {WEEKDAYS.map((w, i) => (
                <option key={i} value={i}>
                  {w}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {kind !== "hourly" && kind !== "cron" ? (
          <label className="pw-set-field pw-auto-inline">
            <span className="pw-set-lbl">小时</span>
            <select
              className="pw-set-input"
              value={hour}
              onChange={(e) => {
                const v = Number(e.target.value);
                setHour(v);
                emit({ hour: v });
              }}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {pad(h)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {kind !== "cron" ? (
          <label className="pw-set-field pw-auto-inline">
            <span className="pw-set-lbl">分钟</span>
            <select
              className="pw-set-input"
              value={minute}
              onChange={(e) => {
                const v = Number(e.target.value);
                setMinute(v);
                emit({ minute: v });
              }}
            >
              {MINUTES.map((m) => (
                <option key={m} value={m}>
                  {pad(m)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {kind === "cron" ? (
        <label className="pw-set-field">
          <span className="pw-set-lbl">cron 表达式（分 时 日 月 周）</span>
          <input
            className="pw-set-input"
            value={expr}
            placeholder="0 9 * * 1-5"
            spellCheck={false}
            onChange={(e) => {
              setExpr(e.target.value);
              emit({ expr: e.target.value });
            }}
          />
          {preview ? (
            <span className={`pw-set-hint ${preview.ok ? "" : "is-danger"}`}>{preview.text}（以实际调度为准）</span>
          ) : null}
        </label>
      ) : null}
    </div>
  );
}
