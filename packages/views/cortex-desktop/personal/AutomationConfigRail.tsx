// 自动化详情右侧配置栏(纯展示):定时 / Agent / 模型 / 推理强度 / 项目 五项摘要 +「编辑」
//(打开 AutomationDialog)+「删除自动化」(菜单/按钮内二次确认)。projectName 由编排器解析后下传,
// 保持本组件无 store 依赖。

import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type { AutomationMeta } from "@cortex-work/core";
import { AGENT_LABEL } from "./agentMeta";
import { EFFORT_LABEL, scheduleSummary } from "./automationFormat";

export function AutomationConfigRail({
  meta,
  projectName,
  onEdit,
  onDelete,
}: {
  meta: AutomationMeta;
  projectName?: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <aside className="pw-auto-config">
      <div className="pw-auto-config-h">
        <span className="pw-auto-config-t">配置</span>
        <button className="pw-auto-config-edit" onClick={onEdit}>
          <Icon.Edit size={13} />
          编辑
        </button>
      </div>

      <div className="pw-auto-cfg-list">
        <div className="pw-auto-cfg-item">
          <span className="pw-auto-cfg-ic"><Icon.Clock size={15} /></span>
          <span className="pw-auto-cfg-k">定时</span>
          <span className="pw-auto-cfg-v">{scheduleSummary(meta.schedule)}</span>
        </div>
        <div className="pw-auto-cfg-item">
          <span className="pw-auto-cfg-ic"><Icon.Bot size={15} /></span>
          <span className="pw-auto-cfg-k">Agent</span>
          <span className="pw-auto-cfg-v">{AGENT_LABEL[meta.agent] ?? meta.agent}</span>
        </div>
        <div className="pw-auto-cfg-item">
          <span className="pw-auto-cfg-ic"><Icon.Sparkle size={15} /></span>
          <span className="pw-auto-cfg-k">模型</span>
          <span className="pw-auto-cfg-v">{meta.model || "默认"}</span>
        </div>
        <div className="pw-auto-cfg-item">
          <span className="pw-auto-cfg-ic"><Icon.Lightning size={15} /></span>
          <span className="pw-auto-cfg-k">推理强度</span>
          <span className="pw-auto-cfg-v">{meta.effort ? EFFORT_LABEL[meta.effort] : "默认"}</span>
        </div>
        <div className="pw-auto-cfg-item">
          <span className="pw-auto-cfg-ic"><Icon.Folder size={15} /></span>
          <span className="pw-auto-cfg-k">项目</span>
          <span className="pw-auto-cfg-v">{projectName ?? "无(主目录)"}</span>
        </div>
      </div>

      <div className="pw-auto-cfg-divider" />
      <button
        className="pw-auto-cfg-danger"
        // 删除二次确认:首点切文案,再点才触发(同顶栏更多菜单的删除模式)。
        onClick={confirming ? onDelete : () => setConfirming(true)}
      >
        <Icon.Trash size={15} />
        {confirming ? "确认删除？" : "删除自动化"}
      </button>
    </aside>
  );
}
