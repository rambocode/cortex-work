// 自动化详情：左=标题+内容(prompt);右=状态(启用开关、下次/上次运行)、配置摘要
// (agent/model/推理强度/项目/定时)、运行历史(可展开看输出/错误)。编辑走 Dialog
// (onEdit),不维护表单副本,数据恒读自 useAutomations 的最新 meta。

import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useAutomationRuns,
  useDeleteAutomationRun,
  useRunAutomationNow,
  useSetAutomationEnabled,
  usePersonalStore,
} from "@cortex-work/core";
import type { AgentKind, AutomationMeta, AutomationRun, ReasoningEffort } from "@cortex-work/core";
import { STATUS_CLASS, STATUS_LABEL, fmtDateTime, scheduleSummary } from "./automationFormat";
import { MarkdownView } from "./MarkdownView";

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };
const EFFORT_LABEL: Record<ReasoningEffort, string> = { low: "低", medium: "中", high: "高" };

// 运行历史「分页加载」每页条数:首屏 + 每次「加载更多」均按此增量。
const RUNS_PAGE_SIZE = 10;

function fmtDuration(run: AutomationRun): string {
  if (!run.endedAt) return "";
  const s = Math.round((run.endedAt - run.startedAt) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// 一键复制按钮:写剪贴板 + 1.5s「已复制」反馈。navigator.clipboard 在 Electron renderer
// 安全上下文可用,不可用时静默忽略（逻辑同 MarkdownView 的代码块复制）。
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <button
      type="button"
      className="pw-icon-btn"
      title={copied ? "已复制" : "复制输出"}
      onClick={() => {
        if (!navigator.clipboard?.writeText) return;
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? <Icon.Check size={15} /> : <Icon.Copy size={15} />}
    </button>
  );
}

// 运行历史的一行：点击进入运行结果详情页（仿 TodosView 的任务行 → 详情切换）;
// 行尾删除按钮 hover 浮现,删除单条历史(stopPropagation 避免触发打开)。
function RunItem({ run, onOpen, onDelete }: { run: AutomationRun; onOpen: () => void; onDelete: () => void }) {
  return (
    <div className="pw-auto-run">
      <button className="pw-auto-run-h" onClick={onOpen}>
        <span className={`pw-auto-badge ${STATUS_CLASS[run.status]}`}>{STATUS_LABEL[run.status]}</span>
        <span className="pw-auto-run-time">{fmtDateTime(run.startedAt)}</span>
        {run.trigger === "manual" ? <span className="pw-auto-run-tag">手动</span> : null}
        <span className="pw-auto-run-dur">{fmtDuration(run)}</span>
        <Icon.Chevron size={11} />
      </button>
      <button
        type="button"
        className="pw-auto-run-del"
        title="删除此记录"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <Icon.Trash size={12} />
      </button>
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
  const delRun = useDeleteAutomationRun();
  const projects = usePersonalStore((s) => s.projects);
  const projectName = meta.projectId ? projects.find((p) => p.id === meta.projectId)?.name : undefined;

  // 运行结果二级详情：列表 → 自动化详情 → 运行结果详情。选中态只存 id,
  // 当前运行恒从 React Query 的 runs 现取,避免持有过期对象。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRun = selectedRunId ? runs.find((r) => r.id === selectedRunId) : undefined;

  // 运行历史分页:客户端增量渲染(runs 已全量在内存,逐页揭示,避免一次性铺满)。
  const [visibleCount, setVisibleCount] = useState(RUNS_PAGE_SIZE);
  // 切换自动化(组件实例复用)时,重置选中态与分页,避免串场。
  useEffect(() => {
    setSelectedRunId(null);
    setVisibleCount(RUNS_PAGE_SIZE);
  }, [meta.id]);

  // 选中的运行记录失效(被删除/刷新后消失)时自动退出详情(对齐 TodosView)。
  useEffect(() => {
    if (selectedRunId && !runs.some((r) => r.id === selectedRunId)) setSelectedRunId(null);
  }, [selectedRunId, runs]);

  // 删除单条运行记录;back=true 时(在详情页删除)删后退回历史列表。
  const removeRun = (runId: string, back?: boolean) => {
    delRun.mutate(
      { automationId: meta.id, runId },
      {
        onSuccess: () => {
          onToast("已删除运行记录");
          if (back) setSelectedRunId(null);
        },
        onError: (e) => onToast(`删除失败：${e instanceof Error ? e.message : String(e)}`),
      },
    );
  };

  const execute = () => {
    runNow.mutate(meta.id, {
      onSuccess: (run) =>
        onToast(run?.status === "skipped" ? "上次还在运行,已跳过" : `已触发「${meta.name}」`),
      onError: (err) => onToast(`执行失败：${err instanceof Error ? err.message : String(err)}`),
    });
  };

  // 运行结果详情页:整页切换,正文用 Markdown 渲染(与点开 Tasks 任务详情一致)。
  if (selectedRun) {
    const body = selectedRun.error || selectedRun.output;
    return (
      <div className="pw-auto-detail">
        <div className="pw-panel-h">
          <button className="pw-icon-btn" title="返回" onClick={() => setSelectedRunId(null)}>
            <Icon.Back size={15} />
          </button>
          <span className={`pw-auto-badge ${STATUS_CLASS[selectedRun.status]}`}>
            {STATUS_LABEL[selectedRun.status]}
          </span>
          <span className="pw-panel-title">{fmtDateTime(selectedRun.startedAt)}</span>
          <div className="pw-panel-h-actions">
            {selectedRun.trigger === "manual" ? <span className="pw-auto-run-tag">手动</span> : null}
            <span className="pw-auto-run-dur">{fmtDuration(selectedRun)}</span>
            <CopyButton text={body || ""} />
            <button className="pw-icon-btn" title="删除此记录" onClick={() => removeRun(selectedRun.id, true)}>
              <Icon.Trash size={15} />
            </button>
          </div>
        </div>
        <div className={`pw-todo-md ${selectedRun.error ? "is-err" : ""}`}>
          <MarkdownView content={body || "（无输出）"} />
        </div>
      </div>
    );
  }

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
            <div className="pw-auto-detail-label">运行历史{runs.length > 0 ? `（${runs.length}）` : ""}</div>
            {runs.length === 0 ? (
              <div className="pw-auto-runs-empty">暂无运行记录</div>
            ) : (
              <>
                {runs.slice(0, visibleCount).map((r) => (
                  <RunItem
                    key={r.id}
                    run={r}
                    onOpen={() => setSelectedRunId(r.id)}
                    onDelete={() => removeRun(r.id)}
                  />
                ))}
                {runs.length > visibleCount ? (
                  <button
                    type="button"
                    className="pw-auto-run-more"
                    onClick={() => setVisibleCount((c) => c + RUNS_PAGE_SIZE)}
                  >
                    加载更多（剩 {runs.length - visibleCount} 条）
                  </button>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
