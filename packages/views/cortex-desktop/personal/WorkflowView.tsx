// 工作流（loop）主区视图容器：列表 ↔ 编辑器本地切换。
// selectedWorkflowId 为 null 时显示列表页（WorkflowList），
// 非空时显示 WorkflowEditorView（U6 画布编辑器）。
// U15 已接线：导出（useExportWorkflow）和导入（useImportWorkflow）真实实现。
// 仿 AutomationView 的视图切换模式（列表 ↔ 详情本地 state）。

import { useEffect, useRef, useState } from "react";
import {
  useWorkflows,
  useWorkflowEvents,
  useCreateWorkflow,
  useExportWorkflow,
  useImportWorkflow,
} from "@cortex-work/core";
import type { WorkflowDef } from "@cortex-work/core";
import { WorkflowList } from "./WorkflowList";
import { WorkflowEditorView } from "./WorkflowEditorView";

// ── 主容器 ───────────────────────────────────────────────────────────────────

export function WorkflowView({ onToast }: { onToast: (text: string) => void }) {
  // 订阅工作流事件（workflow:changed / workflow:run:event），驱动 React Query 缓存更新。
  // 必须在工作流功能区根部挂载一次：列表与编辑器都依赖运行事件实时刷新 runs 缓存，
  // 缺它会导致「运行中」状态永不更新（无节点日志、停止无效）。
  useWorkflowEvents();
  const { data: workflows = [] } = useWorkflows();
  const createWorkflow = useCreateWorkflow();
  const exportWorkflow = useExportWorkflow();
  const importWorkflow = useImportWorkflow();
  // selectedWorkflowId 为 null = 列表页；非 null = 编辑器
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  // 隐藏的文件输入，用于导入工作流文件
  const importInputRef = useRef<HTMLInputElement>(null);

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

  /**
   * 导出工作流为 DSL JSON 文件。
   * 调用 IPC workflow:export → 得到 WorkflowDslV1 对象 → 序列化为 JSON → 触发下载。
   * 文件名：<工作流名>-loop.json（去除非法文件名字符）。
   */
  const handleExport = async (wf: WorkflowDef) => {
    try {
      const dsl = await exportWorkflow.mutateAsync(wf.id);
      const json = JSON.stringify(dsl, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const safeName = (wf.name || "loop").replace(/[/\\?%*:|"<>]/g, "-");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}-loop.json`;
      a.click();
      URL.revokeObjectURL(url);
      onToast(`已导出「${wf.name || "未命名 loop"}」`);
    } catch (e) {
      onToast(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * 导入工作流：触发文件选择框 → 读取 JSON → 调用 IPC workflow:import。
   * 含 code/custom 节点时显示安全提示（主进程已记录 console.info）。
   */
  const handleImport = () => {
    // 重置 value 以允许重复选同一文件
    if (importInputRef.current) importInputRef.current.value = "";
    importInputRef.current?.click();
  };

  const handleImportFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        onToast("导入失败：文件不是有效的 JSON");
        return;
      }
      const def = await importWorkflow.mutateAsync(parsed);
      onToast(`已导入「${def.name || "未命名 loop"}」`);
      // 导入后跳转到编辑器，方便用户检查并手动启用
      setSelectedWorkflowId(def.id);
    } catch (err) {
      onToast(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
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
    <>
      {/* 隐藏的文件输入（导入用）*/}
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => void handleImportFileChange(e)}
        aria-hidden
      />
      <WorkflowList
        onCreate={handleCreate}
        onEdit={(wf) => setSelectedWorkflowId(wf.id)}
        onExport={(wf) => void handleExport(wf)}
        onImport={handleImport}
        onToast={onToast}
      />
    </>
  );
}
