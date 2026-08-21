// 共享 agent 选择器：自定义下拉（按钮内含 agent 小头像 + 名称 + chevron），复用顶栏菜单交互范式
// （点击展开 / 点外部·Esc·失焦关闭 / 移出延时收起）。未探测到安装的(非 pi) agent 禁用并标注。
//
// 从 PersonalTopBar 的私有 PersonalAgentSelect 抽出,入参由「session 对象」改为裸值
// （agent + derivedAgentId），使其不依赖会话即可复用：会话头传 session.agent/session.derivedAgentId，
// 新会话落地页传 draft.agent/draft.derivedAgentId。候选/门控/显示逻辑单一来源,避免两处漂移。
//
// 菜单项本身（含副标题文案）已抽到 AgentMenuItems，与 composer 的 ModelThinkingPill 共用。

import type { AgentKind, DerivedAgentMeta } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { agentDisplayAvatar, agentDisplayLabel } from "./agentMeta";
import { AgentMenuItems } from "./AgentMenuItems";
import { useDismissableMenu } from "../shared/useDismissableMenu";

export function AgentSelect({
  agent,
  derivedAgentId,
  agentsAvailable,
  derivedAgents,
  onSwitch,
  menuPlacement = "down",
  menuAlign = "right",
}: {
  // 当前选中的内置 base agent（session.agent / draft.agent 始终存 base）。
  agent: AgentKind;
  // 选中的派生 id（存在则显示派生名/头像并据此判定选中态）；内置时省略。
  derivedAgentId?: string;
  agentsAvailable: Partial<Record<AgentKind, boolean>> | undefined;
  derivedAgents: DerivedAgentMeta[] | undefined;
  onSwitch: (agent: AgentKind, derived?: DerivedAgentMeta) => void;
  // 菜单弹出方向：顶栏会话头默认向下;底部 composer 工具栏传 "up" 向上,避免被下方区域遮挡。
  menuPlacement?: "down" | "up";
  // 水平对齐：默认右对齐(菜单右缘贴按钮右缘,向左展开)。按钮靠近容器左缘时传 "left",
  // 否则 180px 宽的菜单会越过容器左边界被裁掉(设计助手栏实测)。
  menuAlign?: "left" | "right";
}) {
  const menu = useDismissableMenu();
  // 当前选中键:派生优先(显示派生名/头像),否则内置 base。
  const displayKey = derivedAgentId ?? agent;
  const avatar = agentDisplayAvatar(displayKey, derivedAgents);

  return (
    <div className="pw-sh-agent">
      {/* 清爽化改版:去掉「Agent」前缀文字标签——按钮本身(头像+名称)已自明,标签是冗余重复 */}
      <div
        className="pw-tb-menu-wrap"
        ref={menu.wrapRef}
        onMouseLeave={menu.onMouseLeave}
        onMouseEnter={menu.onMouseEnter}
      >
        <button
          type="button"
          className="pw-sh-agent-btn"
          aria-haspopup="menu"
          aria-expanded={menu.open}
          onClick={() => menu.setOpen((v) => !v)}
        >
          <span className="pw-sh-agent-avatar" style={{ background: avatar.bg }}>
            {avatar.initials}
          </span>
          <span className="pw-sh-agent-name">{agentDisplayLabel(displayKey, derivedAgents)}</span>
          <span className={`pw-sh-chev ${menu.open ? "is-open" : ""}`}>
            <Icon.Chevron size={11} />
          </span>
        </button>
        {menu.open ? (
          <div
            className={`pw-tb-menu${menuPlacement === "up" ? " pw-tb-menu--up" : ""}${
              menuAlign === "left" ? " pw-tb-menu--left" : ""
            }`}
            role="menu"
          >
            <AgentMenuItems
              agent={agent}
              derivedAgentId={derivedAgentId}
              agentsAvailable={agentsAvailable}
              derivedAgents={derivedAgents}
              onSwitch={onSwitch}
              onClose={() => menu.setOpen(false)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
