// 自动化主区视图容器：列表 ↔ 详情本地切换（仿 TodosView,选中态用本地 state,
// 不进全局 store）。新建/编辑共用 AutomationDialog。选中项被删除时自动回列表。

import { useEffect, useState } from "react";
import { useAutomations } from "@cortex-work/core";
import type { AutomationMeta } from "@cortex-work/core";
import { AutomationList } from "./AutomationList";
import { AutomationDetail } from "./AutomationDetail";
import { AutomationDialog } from "./AutomationDialog";

type DialogState = { mode: "create" } | { mode: "edit"; meta: AutomationMeta } | null;

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
          onToast={onToast}
        />
      )}
      {dialog ? (
        <AutomationDialog
          meta={dialog.mode === "edit" ? dialog.meta : undefined}
          onClose={() => setDialog(null)}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}
