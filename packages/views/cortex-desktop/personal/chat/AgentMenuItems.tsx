// agent 选择下拉的菜单项（两行式：主名 + 副标题说明）。
//
// 抽出的原因：AgentSelect（会话顶栏 / 写作栏 / 设计栏）与 ModelThinkingPill（新会话落地页
// composer 的三行级联）此前各有一份「候选 / 门控 / 选中态」逻辑，后者注释里明写「照搬
// AgentSelect」——两处漂移只是时间问题。副标题文案更必须单一口径，否则同一个 agent 在两个
// 入口给出不同解释。
//
// 副标题承担本次改名的核心指路职责：pi 对用户显示为 "Cortex"，用户需要立刻知道
// 「它的模型在哪配」——即「设置 → 模型」（该 tab 的枚举值仍是 "pi"，只是显示名改了）。

import { AGENT_LABEL, AGENT_MODELS } from "@cortex-work/core";
import type { AgentKind, DerivedAgentMeta } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { Icon } from "@cortex-work/ui/icons";

// 内置 agent 的 id 集合。派生候选要排除掉「覆盖内置同名 id」的那些（它们仍走内置项，R1）。
const BUILT_IN: readonly string[] = ["claude", "codex", "pi"];

export function AgentMenuItems({
  agent,
  derivedAgentId,
  agentsAvailable,
  derivedAgents,
  onSwitch,
  onClose,
  checkSize = 13,
}: {
  // 当前选中的内置 base agent（session.agent / draft.agent 始终存 base）。
  // 可空:ModelThinkingPill 的 agent 维度是 opt-in 的，未传时不高亮任何项。
  agent: AgentKind | undefined;
  // 选中的派生 id（存在则据此判定选中态）；内置时省略。
  derivedAgentId?: string;
  agentsAvailable: Partial<Record<AgentKind, boolean>> | undefined;
  derivedAgents: DerivedAgentMeta[] | undefined;
  onSwitch: (agent: AgentKind, derived?: DerivedAgentMeta) => void;
  onClose: () => void;
  // 勾选图标尺寸：顶栏 13、composer 级联 14（沿用各自原值，避免视觉回归）。
  checkSize?: number;
}) {
  const { t } = useTranslation("chat");
  const derivedNew = (derivedAgents ?? []).filter((d) => !BUILT_IN.includes(d.id));

  return (
    <>
      {(Object.keys(AGENT_MODELS) as AgentKind[]).map((a) => {
        // pi（显示为 Cortex）是内置兜底，随包打成自包含二进制，永不禁用；
        // 其余 agent 依赖本机 PATH 上的外部 CLI，未探测到安装时禁用。
        const unavailable = a !== "pi" && agentsAvailable?.[a] === false;
        return (
          <button
            key={a}
            type="button"
            className="pw-tb-menu-item pw-agent-item"
            role="menuitem"
            disabled={unavailable}
            onClick={() => {
              if (unavailable) return;
              onSwitch(a);
              onClose();
            }}
          >
            <span className="pw-agent-name">
              {AGENT_LABEL[a]}
              {/* Cortex 的「内置」用强调色小字挂在名字后。常态说明（原先那行
                  「需本机安装 CLI」/「内置 · 用「设置 → 模型」配置的供应商」）已去掉：
                  每项都顶一行灰字，菜单被撑得很高，而这些信息只在第一次看时有用。 */}
              {a === "pi" ? <span className="pw-agent-badge">{t("agentPicker.builtinBadge")}</span> : null}
              {/* 未安装是**异常态**，必须留：否则用户只看到一项灰掉，不知道为什么点不动。 */}
              {unavailable ? <span className="pw-agent-note">{t("agentPicker.cliMissing")}</span> : null}
            </span>
            {/* 选中态:内置项当且仅当无派生标记且 base 匹配(避免派生时把内置也打勾)。 */}
            {a === agent && !derivedAgentId ? <Icon.Check size={checkSize} /> : null}
          </button>
        );
      })}
      {/* 用户 JSON 派生的新 agent(U7)。派生跳过 PATH 门控(后端放行),不置灰。 */}
      {derivedNew.map((d) => (
        <button
          key={d.id}
          type="button"
          className="pw-tb-menu-item pw-agent-item"
          role="menuitem"
          onClick={() => {
            onSwitch(d.base, d);
            onClose();
          }}
        >
          <span className="pw-agent-name">
            {d.label ?? d.id}
            {/* 派生 agent 的名字是用户自取的，不标出底座就看不出它到底跑哪个 CLI。 */}
            <span className="pw-agent-note">{t("agentPicker.derivedSub", { base: AGENT_LABEL[d.base] })}</span>
          </span>
          {d.id === derivedAgentId ? <Icon.Check size={checkSize} /> : null}
        </button>
      ))}
    </>
  );
}
