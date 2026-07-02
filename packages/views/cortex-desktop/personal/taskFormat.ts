// 个人任务字段的展示格式化（跨组件共享，去重原 TaskOutlineRow / TaskInlineInspector 各存一份的 fmtDur）。

// 预估时长展示：≥60min 折算 h/m（整点省略分钟），否则纯分钟。中列大纲 chip 与行内 inspector 同口径。
export const fmtDur = (m: number): string =>
  m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`;
