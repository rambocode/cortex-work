// 自动化详情(编排器):组装顶部操作栏 + 主滚动区(状态 meta 行 / 最新结果 hero / 运行历史) +
// 右侧配置栏;并保留「整页运行详情」(选中某次运行看完整 Markdown 输出)。提示词不占主区,
// 经顶部/配置栏「编辑」弹窗或「更多 → 复制提示词」访问。
// 全部子组件为纯展示,本编排器持有唯一本地态(selectedRunId,仿 TodosView 不进全局 store)与
// 全部 React Query mutation 接线(启用/运行/副本/导出/删除)。编辑仍走 AutomationDialog(onEdit)。

import { useEffect, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  useAutomationRuns,
  useCreateAutomation,
  useDeleteAutomation,
  useDeleteAutomationRun,
  useRunAutomationNow,
  useSetAutomationEnabled,
  usePersonalStore,
} from "@cortex-work/core";
import type { AutomationMeta } from "@cortex-work/core";
import { STATUS_CLASS, STATUS_LABEL, fmtDateTime, fmtDuration, scheduleSummary } from "./automationFormat";
import { buildDuplicateInput, serializeRunsForExport } from "./automationActions";
import { MarkdownView } from "./MarkdownView";
import { CopyButton } from "./CopyButton";
import { AutomationDetailHeader } from "./AutomationDetailHeader";
import { AutomationHeroCard } from "./AutomationHeroCard";
import { AutomationRunHistory } from "./AutomationRunHistory";
import { AutomationConfigRail } from "./AutomationConfigRail";

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
  const delAuto = useDeleteAutomation();
  const createAuto = useCreateAutomation();
  const projects = usePersonalStore((s) => s.projects);
  const projectName = meta.projectId ? projects.find((p) => p.id === meta.projectId)?.name : undefined;

  // 运行结果二级详情:列表 → 详情 → 运行结果整页。选中态只存 id,当前 run 恒从 runs 现取。
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const selectedRun = selectedRunId ? runs.find((r) => r.id === selectedRunId) : undefined;

  // 切换自动化(组件实例复用)时重置选中态,避免串场。
  useEffect(() => {
    setSelectedRunId(null);
  }, [meta.id]);

  // 选中的运行记录失效(被删除/刷新后消失)时自动退出整页详情。
  useEffect(() => {
    if (selectedRunId && !runs.some((r) => r.id === selectedRunId)) setSelectedRunId(null);
  }, [selectedRunId, runs]);

  // 删除单条运行记录;back=true(在整页详情删除)删后退回列表。
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

  const toggleEnabled = () =>
    setEnabled.mutate(
      { id: meta.id, enabled: !meta.enabled },
      { onError: (e) => onToast(`操作失败：${e instanceof Error ? e.message : String(e)}`) },
    );

  // 删除整条自动化:成功后退回列表(AutomationView 也会因选中项消失自动回退,双保险幂等)。
  const deleteAutomation = () =>
    delAuto.mutate(meta.id, {
      onSuccess: () => {
        onToast(`已删除「${meta.name}」`);
        onBack();
      },
      onError: (e) => onToast(`删除失败：${e instanceof Error ? e.message : String(e)}`),
    });

  // 创建副本:从当前 meta 构造 Input(剥服务端字段、名称加「 副本」),走 create。
  const duplicate = () =>
    createAuto.mutate(buildDuplicateInput(meta), {
      onSuccess: () => onToast("已创建副本"),
      onError: (e) => onToast(`创建副本失败：${e instanceof Error ? e.message : String(e)}`),
    });

  // 导出运行历史:渲染端 Blob + <a download> 下载 JSON(bridge 无保存对话框,故走浏览器下载)。
  const exportRuns = () => {
    try {
      const { filename, content } = serializeRunsForExport(meta, runs, new Date());
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onToast("运行历史已导出");
    } catch (e) {
      onToast(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const copyPrompt = () => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(meta.prompt).then(() => onToast("已复制提示词")).catch(() => {});
  };

  // ── 整页运行详情:整页切换,正文 Markdown 渲染(与 Tasks 任务详情一致)──
  if (selectedRun) {
    const body = selectedRun.error || selectedRun.output;
    return (
      <div className="pw-auto-detail">
        <div className="pw-panel-h">
          <button className="pw-icon-btn" title="返回" onClick={() => setSelectedRunId(null)}>
            <Icon.Back size={15} />
          </button>
          <span className={`pw-auto-badge ${STATUS_CLASS[selectedRun.status]}`}>{STATUS_LABEL[selectedRun.status]}</span>
          <span className="pw-panel-title">{fmtDateTime(selectedRun.startedAt)}</span>
          <div className="pw-panel-h-actions">
            {selectedRun.trigger === "manual" ? <span className="pw-auto-run-tag">手动</span> : null}
            <span className="pw-auto-run-dur">{fmtDuration(selectedRun)}</span>
            <CopyButton text={body || ""} title="复制输出" />
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

  const latest = runs[0];

  return (
    <div className="pw-auto-detail">
      <AutomationDetailHeader
        name={meta.name}
        enabled={meta.enabled}
        running={runNow.isPending}
        onBack={onBack}
        onToggleEnabled={toggleEnabled}
        onRun={execute}
        onEdit={() => onEdit(meta)}
        onCopyPrompt={copyPrompt}
        onExport={exportRuns}
        onDuplicate={duplicate}
        onDelete={deleteAutomation}
      />

      <div className="pw-auto-dt-body">
        <div className="pw-auto-dt-scroll">
          {/* 状态 meta 行 */}
          <div className="pw-auto-meta-line">
            {meta.lastStatus ? (
              <span className={`pw-auto-ml ${STATUS_CLASS[meta.lastStatus]}`}>
                <span className="pw-auto-ml-dot" />
                上次{STATUS_LABEL[meta.lastStatus]}
              </span>
            ) : (
              <span className="pw-auto-ml">尚未运行</span>
            )}
            <span className="pw-auto-ml-sep">·</span>
            <span className="pw-auto-ml">
              {fmtDateTime(meta.lastRunAt)}
              {latest && fmtDuration(latest) ? ` · 耗时 ${fmtDuration(latest)}` : ""}
            </span>
            <span className="pw-auto-ml-sep">·</span>
            <span className="pw-auto-ml">
              下次运行 <b>{meta.enabled ? fmtDateTime(meta.nextRunAt) : "—(已停用)"}</b>
            </span>
            <span className="pw-auto-ml-sep">·</span>
            <span className="pw-auto-ml">
              定时 <b>{scheduleSummary(meta.schedule)}</b>
            </span>
          </div>

          {/* 最新结果 hero */}
          <div className="pw-auto-sec-h">最新结果</div>
          <AutomationHeroCard latestRun={latest} onRerun={execute} />

          {/* 提示词不再占主区:经顶部/配置栏「编辑」(弹窗)或「更多 → 复制提示词」访问。 */}

          {/* 运行历史 */}
          <AutomationRunHistory
            runs={runs}
            onOpenRun={(id) => setSelectedRunId(id)}
            onDeleteRun={(id) => removeRun(id)}
          />
        </div>

        <AutomationConfigRail
          meta={meta}
          projectName={projectName}
          onEdit={() => onEdit(meta)}
          onDelete={deleteAutomation}
        />
      </div>
    </div>
  );
}
