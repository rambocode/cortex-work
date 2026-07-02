// 「项目管理」独立窗口顶部自绘工具栏（U4，OmniFocus 式）。
// 布局对齐参考截图：左 = 边栏切换 / 后退 / 前进 / 显示；右 = 新建（单击直接新建动作）/ 快速入口
//（命令面板，⌘O）/ 聚焦（OmniFocus 语义）/ 设置显示字段 / 设置编辑字段（后二者为字段勾选弹层）。
// 「新建」是单一按钮、点击即建动作（U11 简化）；新建项目改由左树「＋」入口承担，不再进本工具栏下拉。
//
// 跨进程契约（KTD8 / R7）：本窗口是 hiddenInset 无边框窗口，整条工具栏 `-webkit-app-region: drag`
// 承担窗口拖拽，所有交互子元素挂 `.ds-no-drag` 恢复点击（照 .ds-drag 与 TitleBar 惯例）；左侧 84px
// 让位 mac 红绿灯（trafficLightPosition x=16，见 projects-window.ts）。
// 「显示」按钮本单元只渲染入口，过滤弹层内容归 U5；快速入口/聚焦的语义（面板开关、焦点态）归容器。
import { Icon } from "@cortex-work/ui/icons";
import { ViewOptionsPopover, type ViewOptions } from "./ViewOptionsPopover";
import { FieldsPopover } from "./FieldsPopover";
import {
  DISPLAY_FIELDS,
  EDIT_FIELDS,
  type DisplayFieldPrefs,
  type EditFieldPrefs,
} from "./workbenchFieldPrefs";

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
  // 快速入口（命令面板）：面板开关与跳转语义归容器（⌘O 亦由容器在 window 级监听），本处只发唤起回调。
  onQuickOpen: () => void;
  // 聚焦（OmniFocus 语义）：选中 project/folder 才可进入（canFocus）；聚焦中高亮并可再点退出。
  focusActive: boolean;
  canFocus: boolean;
  onToggleFocus: () => void;
  // 字段显隐偏好（设置显示 / 编辑字段）：容器经 KTD9 窄通道持久化的受控值与回调。
  // 未提供时降级为 disabled 占位按钮（同 viewOptions 的独立渲染 seam）。
  displayFields?: DisplayFieldPrefs;
  onDisplayFieldsChange?: (next: DisplayFieldPrefs) => void;
  editFields?: EditFieldPrefs;
  onEditFieldsChange?: (next: EditFieldPrefs) => void;
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
  onQuickOpen,
  focusActive,
  canFocus,
  onToggleFocus,
  displayFields,
  onDisplayFieldsChange,
  editFields,
  onEditFieldsChange,
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
        {/* 快速入口（命令面板）：点击唤起容器持有的搜索面板；⌘O 由容器 window 级监听，同门唤起。 */}
        <button className="pw-wb-btn ds-no-drag" title="快速入口（⌘O）" onClick={onQuickOpen}>
          <Icon.Search size={16} />
          <span className="pw-wb-btn-label">快速入口</span>
        </button>
        {/* 聚焦（OmniFocus 语义）：选中 project/folder 才可进入；聚焦态高亮、title 变「取消聚焦」。 */}
        <button
          className={`pw-wb-btn ds-no-drag${focusActive ? " is-on" : ""}`}
          title={focusActive ? "取消聚焦" : "聚焦"}
          aria-pressed={focusActive}
          disabled={!canFocus}
          onClick={onToggleFocus}
        >
          <Icon.Eye size={16} />
          <span className="pw-wb-btn-label">聚焦</span>
        </button>
        {/* 设置显示 / 编辑字段：容器注入受控值时挂 FieldsPopover 勾选弹层；未注入降级为 disabled 占位
            （同 viewOptions 的独立渲染 seam，便于工具栏在无容器时单独渲染/测试）。 */}
        {displayFields && onDisplayFieldsChange ? (
          <FieldsPopover
            icon={<Icon.Settings size={16} />}
            title="设置显示字段"
            options={DISPLAY_FIELDS}
            value={displayFields}
            onChange={onDisplayFieldsChange}
          />
        ) : (
          <button className="pw-wb-btn ds-no-drag" title="设置显示字段" disabled>
            <Icon.Settings size={16} />
          </button>
        )}
        {editFields && onEditFieldsChange ? (
          <FieldsPopover
            icon={<Icon.Edit size={16} />}
            title="设置编辑字段"
            options={EDIT_FIELDS}
            value={editFields}
            onChange={onEditFieldsChange}
          />
        ) : (
          <button className="pw-wb-btn ds-no-drag" title="设置编辑字段" disabled>
            <Icon.Edit size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
