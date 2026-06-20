// 自动化主区视图容器：列表 ↔ 详情本地切换（仿 TodosView,选中态用本地 state,
// 不进全局 store）。新建/编辑共用 AutomationDialog。选中项被删除时自动回列表。

import { useEffect, useState } from "react";
import { useAutomations } from "@cortex-work/core";
import type { AutomationInput, AutomationMeta } from "@cortex-work/core";
import { AutomationList } from "./AutomationList";
import { AutomationDetail } from "./AutomationDetail";
import { AutomationDialog } from "./AutomationDialog";
import type { AutomationTemplate } from "./automationTemplates";

type DialogState =
  | { mode: "create" }
  | { mode: "edit"; meta: AutomationMeta }
  | { mode: "template"; template: AutomationTemplate } // 点模板:预填新建弹窗,仍走 create
  | null;

// 把模板草稿转成弹窗预填入参。once 模板的 schedule.at 是占位 0,这里用
// Date.now() + onceOffsetMs 计算真正的触发时刻覆盖（其余 schedule 原样透传）。
function templateToInitial(template: AutomationTemplate): Partial<AutomationInput> {
  const { draft } = template;
  let schedule = draft.schedule;
  if (template.onceOffsetMs != null && schedule.kind === "once") {
    schedule = { ...schedule, at: Date.now() + template.onceOffsetMs };
  }
  return {
    name: template.name,
    prompt: draft.prompt,
    effort: draft.effort,
    schedule,
  };
}

export function AutomationView({ onToast }: { onToast: (text: string) => void }) {
  const { data: automations = [] } = useAutomations();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const selected = selectedId ? automations.find((a) => a.id === selectedId) : undefined;

  // 选中项被删除（或事件刷新后消失）→ 回到列表。
  useEffect(() => {
    if (selectedId && !automations.some((a) => a.id === selectedId)) setSelectedId(null);
  }, [selectedId, automations]);

  return (
    <div className="pw-auto-view">
      {selected ? (
        <AutomationDetail
          meta={selected}
          onBack={() => setSelectedId(null)}
          onEdit={(m) => setDialog({ mode: "edit", meta: m })}
          onToast={onToast}
        />
      ) : (
        <AutomationList
          onSelect={setSelectedId}
          onCreate={() => setDialog({ mode: "create" })}
          onEdit={(m) => setDialog({ mode: "edit", meta: m })}
          onPickTemplate={(template) => setDialog({ mode: "template", template })}
          onToast={onToast}
        />
      )}
      {dialog ? (
        <AutomationDialog
          // edit → 传 meta;template → 传 initial(不传 meta,仍走 create);create → 都不传。
          meta={dialog.mode === "edit" ? dialog.meta : undefined}
          initial={dialog.mode === "template" ? templateToInitial(dialog.template) : undefined}
          onClose={() => setDialog(null)}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}
