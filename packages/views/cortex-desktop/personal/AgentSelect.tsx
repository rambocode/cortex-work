// 共享 agent 选择器：自定义下拉（按钮内含 agent 小头像 + 名称 + chevron），复用顶栏菜单交互范式
// （点击展开 / 点外部·Esc·失焦关闭 / 移出延时收起）。未探测到安装的(非 pi) agent 禁用并标注。
//
// 从 PersonalTopBar 的私有 PersonalAgentSelect 抽出,入参由「session 对象」改为裸值
// （agent + derivedAgentId），使其不依赖会话即可复用：会话头传 session.agent/session.derivedAgentId，
// 新会话落地页传 draft.agent/draft.derivedAgentId。候选/门控/显示逻辑单一来源,避免两处漂移。

import { AGENT_MODELS } from "@cortex-work/core";
import type { AgentKind, DerivedAgentMeta } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { AGENT_LABEL, agentDisplayAvatar, agentDisplayLabel } from "./agentMeta";
import { useDismissableMenu } from "./useDismissableMenu";

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
  // 派生候选:仅「新 id」(覆盖内置同名 id 的派生不新增条目,仍走内置项,R1)。
  const builtIn: readonly string[] = ["claude", "codex", "pi"];
  const derivedNew = (derivedAgents ?? []).filter((d) => !builtIn.includes(d.id));

  return (
    <div className="pw-sh-agent">
      <span className="pw-sh-agent-label">Agent</span>
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
            {(Object.keys(AGENT_MODELS) as AgentKind[]).map((a) => {
              // pi 是内置兜底,永不禁用;其余 agent 未探测到安装时禁用并标注。
              const unavailable = a !== "pi" && agentsAvailable?.[a] === false;
              return (
                <button
                  key={a}
                  className="pw-tb-menu-item"
                  role="menuitem"
                  disabled={unavailable}
                  onClick={() => {
                    if (unavailable) return;
                    onSwitch(a);
                    menu.setOpen(false);
                  }}
                >
                  <span>
                    {AGENT_LABEL[a]}
                    {unavailable ? "（未安装）" : ""}
                  </span>
                  {/* 选中态:内置项当且仅当无派生标记且 base 匹配(避免派生时把内置也打勾)。 */}
                  {a === agent && !derivedAgentId ? <Icon.Check size={13} /> : null}
                </button>
              );
            })}
            {/* 用户 JSON 派生的新 agent(U7)。派生跳过 PATH 门控(后端放行),不置灰。 */}
            {derivedNew.map((d) => (
              <button
                key={d.id}
                className="pw-tb-menu-item"
                role="menuitem"
                onClick={() => {
                  onSwitch(d.base, d);
                  menu.setOpen(false);
                }}
              >
                <span>{d.label ?? d.id}</span>
                {d.id === derivedAgentId ? <Icon.Check size={13} /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
