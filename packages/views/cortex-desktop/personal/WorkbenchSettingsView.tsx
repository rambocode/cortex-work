// 项目工作台全局设置视图（参照 IFocus 设置页）：全窗口覆盖（盖住三列、保留顶部工具栏），
// 左侧菜单（顶部「返回」+ 分区导航：阶段模板 / 项目资源）+ 右侧内容区（对齐主窗口
// SettingsMenu 的左导航右内容范式）。挂在 ProjectsWorkbench（settingsOpen 瞬态）；
// 数据经 core hooks 落 tasks.json，跨窗口一致。
import { useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { StageTemplateManager } from "./StageTemplateManager";
import { MemberManager } from "./MemberManager";

type SettingsTab = "templates" | "resources";

const NAV_ITEMS: readonly { key: SettingsTab; label: string; icon: React.ReactNode }[] = [
  { key: "templates", label: "阶段模板", icon: <Icon.Workflow size={15} /> },
  { key: "resources", label: "项目资源", icon: <Icon.Users size={15} /> },
];

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
      <aside className="pw-ps-nav">
        {/* 返回工作台：替代原右上角 X（导航语义更贴近全屏设置页）。 */}
        <button className="pw-ps-back" title="返回工作台" onClick={onClose}>
          <Icon.Back size={15} />
          <span>返回</span>
        </button>
        <div className="pw-ps-nav-group" role="tablist" aria-label="设置分区">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              role="tab"
              aria-selected={tab === item.key}
              className={`pw-ps-nav-item${tab === item.key ? " is-on" : ""}`}
              onClick={() => setTab(item.key)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </aside>
      <div className="pw-ps-body">
        {tab === "templates" ? <StageTemplateManager onToast={onToast} /> : <MemberManager onToast={onToast} />}
      </div>
    </div>
  );
}
