// 自动化详情「最新结果」hero 卡片(纯展示):突出最近一次运行 runs[0]。
// 顶部:状态徽章 · 时间 · 耗时 · 操作(复制 / 重新运行);正文用 MarkdownView 渲染 output/error。
// 无运行记录时显示空态。KTD7:本期不渲染「在会话中打开」——缺把 chat UI 导航到 run.agentSessionId
// 的桥接能力,待后续单独立项。

import { Icon } from "@cortex-work/ui/icons";
import type { AutomationRun } from "@cortex-work/core";
import { STATUS_CLASS, STATUS_LABEL, fmtDateTime, fmtDuration } from "./automationFormat";
import { MarkdownView } from "./MarkdownView";
import { CopyButton } from "./CopyButton";

export function AutomationHeroCard({
  latestRun,
  onRerun,
}: {
  latestRun?: AutomationRun;
  onRerun: () => void;
}) {
  if (!latestRun) {
    return (
      <div className="pw-auto-hero is-empty">
        <Icon.Workflow size={20} />
        <div className="pw-auto-hero-empty-t">暂无运行结果</div>
        <div className="pw-auto-hero-empty-h">点「立即运行」手动触发一次,结果会显示在这里。</div>
      </div>
    );
  }

  const body = latestRun.error || latestRun.output;
  return (
    <div className="pw-auto-hero">
      <div className="pw-auto-hero-top">
        <span className={`pw-auto-badge ${STATUS_CLASS[latestRun.status]}`}>{STATUS_LABEL[latestRun.status]}</span>
        <span className="pw-auto-hero-when">{fmtDateTime(latestRun.startedAt)}</span>
        {latestRun.trigger === "manual" ? <span className="pw-auto-run-tag">手动</span> : null}
        <span className="pw-auto-hero-dur">{fmtDuration(latestRun)}</span>
        <div className="pw-auto-hero-acts">
          <CopyButton text={body || ""} title="复制结果" />
          <button className="pw-icon-btn" title="重新运行" onClick={onRerun}>
            <Icon.Retry size={15} />
          </button>
        </div>
      </div>
      <div className={`pw-auto-hero-body ${latestRun.error ? "is-err" : ""}`}>
        <MarkdownView content={body || "（无输出）"} />
      </div>
    </div>
  );
}
