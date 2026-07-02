// 「项目管理」独立窗口顶部自绘工具栏（U4，OmniFocus 式）。
// 布局对齐参考截图：左 = 边栏切换 / 后退 / 前进 / 显示；右 = 新建（单击直接新建动作）+ 未实装占位
//（快速入口 / 聚焦 / 设置显示字段 / 设置编辑字段，R12 灰态）。
// 「新建」是单一按钮、点击即建动作（U11 简化）；新建项目改由左树「＋」入口承担，不再进本工具栏下拉。
//
// 跨进程契约（KTD8 / R7）：本窗口是 hiddenInset 无边框窗口，整条工具栏 `-webkit-app-region: drag`
// 承担窗口拖拽，所有交互子元素挂 `.ds-no-drag` 恢复点击（照 .ds-drag 与 TitleBar 惯例）；左侧 84px
// 让位 mac 红绿灯（trafficLightPosition x=16，见 projects-window.ts）。
// 「显示」按钮本单元只渲染入口，过滤弹层内容归 U5；未实装项以 disabled + tooltip 呈现。
import { Icon } from "@cortex-work/ui/icons";
import { ViewOptionsPopover, type ViewOptions } from "./ViewOptionsPopover";

export interface WorkbenchToolbarProps {
  // 边栏显隐（R8）：容器持久化（KTD9 窗口专属窄通道），工具栏只反映态并回调切换。
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
  // 后退 / 前进历史（KTD7，组件级瞬态）：端点由容器算好 canGo* 传入，工具栏据此禁用。
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  // 「显示」过滤弹层（U5）：容器持久化的四档过滤 + 结构开关受控值与回调。
  // 未提供时降级为占位「显示」按钮（保留 U4 seam；便于工具栏在无容器时独立渲染/测试）。
  viewOptions?: ViewOptions;
  onViewOptionsChange?: (next: ViewOptions) => void;
  // 新建动作（任务）：落点语义 U5 完善。
  onNewAction: () => void;
}

export function WorkbenchToolbar({
  sidebarVisible,
  onToggleSidebar,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  viewOptions,
  onViewOptionsChange,
  onNewAction,
}: WorkbenchToolbarProps) {
  return (
    <div className="pw-wb-toolbar ds-drag">
      {/* 左侧 84px 红绿灯让位：纯 drag 区、无交互元素（R7）。 */}
      <div className="pw-wb-traffic-safe" aria-hidden />
      <div className="pw-wb-group">
        <button
          className={`pw-wb-btn ds-no-drag${sidebarVisible ? " is-on" : ""}`}
          title={sidebarVisible ? "隐藏边栏" : "显示边栏"}
          aria-pressed={sidebarVisible}
          onClick={onToggleSidebar}
        >
          <Icon.Sidebar size={16} />
        </button>
        <div className="pw-wb-nav ds-no-drag">
          <button className="pw-wb-btn" title="后退" disabled={!canGoBack} onClick={onBack}>
            <Icon.Back size={16} />
          </button>
          <button className="pw-wb-btn" title="前进" disabled={!canGoForward} onClick={onForward}>
            <Icon.Fwd size={16} />
          </button>
        </div>
        {/* 「显示」过滤弹层（U5）：容器注入受控值时挂 ViewOptionsPopover；否则降级为占位按钮。 */}
        {viewOptions && onViewOptionsChange ? (
          <ViewOptionsPopover value={viewOptions} onChange={onViewOptionsChange} />
        ) : (
          <button className="pw-wb-btn ds-no-drag" title="显示" aria-haspopup="menu" disabled>
            <Icon.Filter size={16} />
            <span className="pw-wb-btn-label">显示</span>
          </button>
        )}
      </div>
      {/* 中间可拖拽空白填充（drag 区）。 */}
      <div className="pw-wb-spacer" />
      <div className="pw-wb-group">
        {/* 「新建」单一按钮：点击直接新建动作（U11）；新建项目走左树「＋」入口。 */}
        <button className="pw-wb-btn ds-no-drag" title="新建动作" onClick={onNewAction}>
          <Icon.Plus size={16} />
          <span className="pw-wb-btn-label">新建</span>
        </button>
        {/* 未实装占位（对齐参考截图灰态，R12）：disabled + tooltip 提示即将推出。 */}
        <button className="pw-wb-btn ds-no-drag" title="快速入口（即将推出）" disabled>
          <Icon.Search size={16} />
          <span className="pw-wb-btn-label">快速入口</span>
        </button>
        <button className="pw-wb-btn ds-no-drag" title="聚焦（即将推出）" disabled>
          <Icon.Eye size={16} />
          <span className="pw-wb-btn-label">聚焦</span>
        </button>
        <button className="pw-wb-btn ds-no-drag" title="设置显示字段（即将推出）" disabled>
          <Icon.Settings size={16} />
        </button>
        <button className="pw-wb-btn ds-no-drag" title="设置编辑字段（即将推出）" disabled>
          <Icon.Edit size={16} />
        </button>
      </div>
    </div>
  );
}
