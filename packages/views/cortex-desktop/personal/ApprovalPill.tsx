// Composer 底部「执行/审批」pill(Image #2 第一个 pill)。单选 2 档,对应 approvalPolicy:
//   自动执行(auto)/ 询问后执行(ask)。
// ask 仅 pi RPC 有真审批回路;claude -p / codex exec 非交互无法中途询问 → 降级(行为同 auto),
// 故 agent 非 pi 时在 tooltip 标注降级映射。复用 pw-model-pill 样式。

import { APPROVAL_POLICIES, DEFAULT_APPROVAL_POLICY, type AgentKind, type ApprovalPolicy } from "@cortex-work/core";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";

export function ApprovalPill({
  approvalPolicy,
  onChange,
  running,
  agent,
}: {
  approvalPolicy?: ApprovalPolicy;
  onChange: (p: ApprovalPolicy) => void;
  running: boolean;
  agent: AgentKind;
}) {
  const { t } = useTranslation("chat");
  const value = approvalPolicy ?? DEFAULT_APPROVAL_POLICY;
  // ask 在 claude/codex 上降级(无中途审批回路);仅 pi 真兑现。
  const askDegraded = value === "ask" && agent !== "pi";
  const title = askDegraded ? t("composer.approval.askDegraded") : t(`composer.approval.${value}Hint`);
  return (
    <span className="pill pw-model-pill" title={title} data-warn={askDegraded ? "1" : undefined}>
      <span className="lightning">
        <Icon.Power size={11} />
      </span>
      <select
        className="pw-model-select"
        value={value}
        onChange={(e) => onChange(e.target.value as ApprovalPolicy)}
        disabled={running}
        aria-label={t("composer.approval.label")}
      >
        {APPROVAL_POLICIES.map((p) => (
          <option key={p} value={p}>
            {t(`composer.approval.${p}`)}
          </option>
        ))}
      </select>
    </span>
  );
}
