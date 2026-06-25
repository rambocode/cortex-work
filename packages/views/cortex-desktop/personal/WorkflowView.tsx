// 工作流（loop）主区视图容器：列表 ↔ 编辑器本地切换。
// selectedWorkflowId 为 null 时显示列表页（WorkflowList），
// 非空时显示 WorkflowEditorView（U6 画布编辑器）。
// 导出按钮：U15 DSL 导出落地后替换为真实实现，目前仅 toast 提示。
// 仿 AutomationView 的视图切换模式（列表 ↔ 详情本地 state）。

import { useEffect, useState } from "react";
import { useWorkflows, useCreateWorkflow } from "@cortex-work/core";
import type { WorkflowDef } from "@cortex-work/core";
import { WorkflowList } from "./WorkflowList";
import { WorkflowEditorView } from "./WorkflowEditorView";

// ── 主容器 ───────────────────────────────────────────────────────────────────

export function WorkflowView({ onToast }: { onToast: (text: string) => void }) {
  const { data: workflows = [] } = useWorkflows();
  const createWorkflow = useCreateWorkflow();
  // selectedWorkflowId 为 null = 列表页；非 null = 编辑器
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);

  const selected = selectedWorkflowId ? workflows.find((w) => w.id === selectedWorkflowId) : undefined;

  // 被选中的工作流被删除（或事件刷新后消失）→ 自动回列表。
  useEffect(() => {
    if (selectedWorkflowId && !workflows.some((w) => w.id === selectedWorkflowId)) {
      setSelectedWorkflowId(null);
    }
  }, [selectedWorkflowId, workflows]);

  /** 新建工作流：创建后直接跳编辑器。 */
  const handleCreate = () => {
    createWorkflow.mutate(
      { name: "新 loop", nodes: [], connections: [], env: [] },
      {
        onSuccess: (def) => {
          if (def) setSelectedWorkflowId(def.id);
          onToast("已新建 loop 工作流");
        },
        onError: (e) => onToast(`新建失败：${e instanceof Error ? e.message : String(e)}`),
      },
    );
  };

  /** 导出：U15 落地前仅提示。U15 完成后替换为真实 DSL 序列化下载。 */
  const handleExport = (wf: WorkflowDef) => {
    // TODO(U15): 替换为 useExportWorkflow + serializeWorkflowDsl 下载
    onToast(`导出功能即将上线（${wf.name || "未命名 loop"}）`);
  };

  // 编辑器视图：找到了对应 workflow 就展示编辑器
  if (selected) {
    return (
      <WorkflowEditorView
        workflow={selected}
        onBack={() => setSelectedWorkflowId(null)}
        onToast={onToast}
      />
    );
  }

  return (
    <WorkflowList
      onCreate={handleCreate}
      onEdit={(wf) => setSelectedWorkflowId(wf.id)}
      onExport={handleExport}
      onToast={onToast}
    />
  );
}
