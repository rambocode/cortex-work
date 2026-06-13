// 自动化详情：左=标题+内容(prompt);右=状态(启用开关、下次/上次运行)、配置摘要
// (agent/model/推理强度/项目/定时)、运行历史(可展开看输出/错误)。编辑走 Dialog
// (onEdit),不维护表单副本,数据恒读自 useAutomations 的最新 meta。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useAutomationRuns,
  useRunAutomationNow,
  useSetAutomationEnabled,
  usePersonalStore,
} from "@cortex-work/core";
import type { AgentKind, AutomationMeta, AutomationRun, ReasoningEffort } from "@cortex-work/core";
import { STATUS_CLASS, STATUS_LABEL, fmtDateTime, scheduleSummary } from "./automationFormat";

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };
const EFFORT_LABEL: Record<ReasoningEffort, string> = { low: "低", medium: "中", high: "高" };

function fmtDuration(run: AutomationRun): string {
  if (!run.endedAt) return "";
  const s = Math.round((run.endedAt - run.startedAt) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

function RunItem({ run }: { run: AutomationRun }) {
  const [open, setOpen] = useState(false);
  const body = run.error || run.output;
  return (
    <div className={`pw-auto-run ${open ? "is-open" : ""}`}>
      <button className="pw-auto-run-h" onClick={() => setOpen((v) => !v)}>
        <span className={`pw-auto-badge ${STATUS_CLASS[run.status]}`}>{STATUS_LABEL[run.status]}</span>
        <span className="pw-auto-run-time">{fmtDateTime(run.startedAt)}</span>
        {run.trigger === "manual" ? <span className="pw-auto-run-tag">手动</span> : null}
        <span className="pw-auto-run-dur">{fmtDuration(run)}</span>
        <Icon.Chevron size={11} />
      </button>
      {open ? (
        <pre className={`pw-auto-run-out ${run.error ? "is-err" : ""}`}>{body || "（无输出）"}</pre>
      ) : null}
    </div>
  );
}

export function AutomationDetail({
  meta,
  onBack,
  onEdit,
  onToast,
}: {
  meta: AutomationMeta;
  onBack: () => void;
  onEdit: (meta: AutomationMeta) => void;
  onToast: (text: string) => void;
}) {
  const { data: runs = [] } = useAutomationRuns(meta.id);
  const runNow = useRunAutomationNow();
  const setEnabled = useSetAutomationEnabled();
  const projects = usePersonalStore((s) => s.projects);
  const projectName = meta.projectId ? projects.find((p) => p.id === meta.projectId)?.name : undefined;

  const execute = () => {
    runNow.mutate(meta.id, {
      onSuccess: (run) =>
        onToast(run?.status === "skipped" ? "上次还在运行,已跳过" : `已触发「${meta.name}」`),
      onError: (err) => onToast(`执行失败：${err instanceof Error ? err.message : String(err)}`),
    });
  };

  return (
    <div className="pw-auto-detail">
      <div className="pw-panel-h">
        <button className="pw-icon-btn" title="返回" onClick={onBack}>
          <Icon.Back size={15} />
        </button>
        <span className="pw-panel-title">{meta.name || "未命名自动化"}</span>
        <div className="pw-panel-h-actions">
          <button className="pw-icon-btn" title="立即执行" onClick={execute}>
            <Icon.Run size={15} />
          </button>
          <button className="pw-icon-btn" title="编辑" onClick={() => onEdit(meta)}>
            <Icon.Edit size={15} />
          </button>
        </div>
      </div>

      <div className="pw-auto-detail-body">
        <div className="pw-auto-detail-left">
          <div className="pw-auto-detail-label">内容（提示词）</div>
          <pre className="pw-auto-prompt">{meta.prompt}</pre>
        </div>

        <div className="pw-auto-detail-right">
          <div className="pw-auto-card">
            <div className="pw-auto-card-row">
              <span>启用</span>
              <button
                type="button"
                className="twk-toggle"
                data-on={meta.enabled ? "1" : "0"}
                role="switch"
                aria-checked={meta.enabled}
                title={meta.enabled ? "点击暂停" : "点击恢复"}
                onClick={() =>
                  setEnabled.mutate(
                    { id: meta.id, enabled: !meta.enabled },
                    { onError: (e) => onToast(`操作失败：${e instanceof Error ? e.message : String(e)}`) },
                  )
                }
              >
                <i />
              </button>
            </div>
            <div className="pw-auto-card-row">
              <span>下次运行</span>
              <b>{meta.enabled ? fmtDateTime(meta.nextRunAt) : "—（已暂停）"}</b>
            </div>
            <div className="pw-auto-card-row">
              <span>上次运行</span>
              <b>{fmtDateTime(meta.lastRunAt)}</b>
            </div>
            {meta.lastStatus ? (
              <div className="pw-auto-card-row">
                <span>上次结果</span>
                <span className={`pw-auto-badge ${STATUS_CLASS[meta.lastStatus]}`}>{STATUS_LABEL[meta.lastStatus]}</span>
              </div>
            ) : null}
          </div>

          <div className="pw-auto-card">
            <div className="pw-auto-card-row">
              <span>定时</span>
              <b>{scheduleSummary(meta.schedule)}</b>
            </div>
            <div className="pw-auto-card-row">
              <span>Agent</span>
              <b>{AGENT_LABEL[meta.agent]}</b>
            </div>
            <div className="pw-auto-card-row">
              <span>模型</span>
              <b>{meta.model || "默认"}</b>
            </div>
            <div className="pw-auto-card-row">
              <span>推理强度</span>
              <b>{meta.effort ? EFFORT_LABEL[meta.effort] : "默认"}</b>
            </div>
            <div className="pw-auto-card-row">
              <span>项目</span>
              <b>{projectName ?? "无（主目录）"}</b>
            </div>
          </div>

          <div className="pw-auto-runs">
            <div className="pw-auto-detail-label">运行历史</div>
            {runs.length === 0 ? (
              <div className="pw-auto-runs-empty">暂无运行记录</div>
            ) : (
              runs.map((r) => <RunItem key={r.id} run={r} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
