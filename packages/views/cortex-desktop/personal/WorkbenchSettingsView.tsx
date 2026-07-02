// 项目工作台全局设置视图（参照 IFocus 设置页）：全窗口覆盖（盖住三列、保留顶部工具栏），
// 顶部 tab 切换「阶段模板 / 项目资源」，右上关闭回工作台。内容体量大故用覆盖视图而非弹层。
// 挂在 ProjectsWorkbench（settingsOpen 瞬态）；数据经 core hooks 落 tasks.json，跨窗口一致。
import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { StageTemplateManager } from "./StageTemplateManager";
import { MemberManager } from "./MemberManager";

type SettingsTab = "templates" | "resources";

export function WorkbenchSettingsView({
  onClose,
  onToast,
}: {
  onClose: () => void;
  onToast: (text: string) => void;
}) {
  const [tab, setTab] = useState<SettingsTab>("templates");

  return (
    <div className="pw-ps-view" role="dialog" aria-label="项目设置">
      <div className="pw-ps-head">
        <div className="pw-ps-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "templates"}
            className={`pw-ps-tab${tab === "templates" ? " is-on" : ""}`}
            onClick={() => setTab("templates")}
          >
            阶段模板
          </button>
          <button
            role="tab"
            aria-selected={tab === "resources"}
            className={`pw-ps-tab${tab === "resources" ? " is-on" : ""}`}
            onClick={() => setTab("resources")}
          >
            项目资源
          </button>
        </div>
        <button className="pw-ps-icon-btn" title="关闭设置" aria-label="关闭设置" onClick={onClose}>
          <Icon.X size={16} />
        </button>
      </div>
      <div className="pw-ps-body">
        {tab === "templates" ? <StageTemplateManager onToast={onToast} /> : <MemberManager onToast={onToast} />}
      </div>
    </div>
  );
}
