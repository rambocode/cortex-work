// 模型能力的**只读**展示件：token 数格式化 + 能力徽标。
//
// 这个文件里刻意没有任何可交互控件。旧版设置页把「推理 / 视觉 / 上下文」做成 checkbox 与输入框，
// 用户填写的值被写进 pi extension 并**替换掉整份内置模型目录**（研究文档 §3 的差分实测：
// context 272K→131K、maxTokens 128K→8.2K、reasoning yes→no、images yes→no），
// 这就是图片被换成 `(image omitted...)` 的根因。能力只读是本次修复的核心约束。

import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import type { CatalogModel } from "@cortex-work/core/desktop/provider-catalog";

/** token 数 → 紧凑展示："1M" / "128K" / "512"。 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`;
  if (tokens >= 1_000) return `${+(tokens / 1_000).toFixed(tokens % 1_000 ? 1 : 0)}K`;
  return String(tokens);
}

/**
 * 模型能力徽标行。`compact` 只显最关键的三项（图片 / 推理 / 上下文），用于模型选择器列表；
 * 完整模式再加最大输出、协议与成本，用于 Provider 详情的只读模型列表。
 */
export function CapabilityBadges({ model, compact }: { model: CatalogModel; compact?: boolean }) {
  const { t } = useTranslation("settings");
  const image = model.input.includes("image");
  return (
    <span className="pw-cap-badges">
      {/* 图片能力是本次事故的核心，正反两态都显式标出——「没有图片徽标」不该被读成「不确定」。 */}
      <span className={`pw-cap-badge ${image ? "is-image" : "is-muted"}`}>
        {image ? <Icon.Image size={11} /> : null}
        {image ? t("providers.models.badgeImage") : t("providers.models.badgeTextOnly")}
      </span>
      {model.reasoning ? <span className="pw-cap-badge">{t("providers.models.badgeReasoning")}</span> : null}
      <span className="pw-cap-badge">
        {t("providers.models.badgeContext", { value: formatTokens(model.contextWindow) })}
      </span>
      {compact ? null : (
        <>
          <span className="pw-cap-badge">
            {t("providers.models.badgeMaxOutput", { value: formatTokens(model.maxTokens) })}
          </span>
          {model.api ? (
            <span className="pw-cap-badge is-api">{t("providers.models.badgeApi", { value: model.api })}</span>
          ) : null}
          <span className="pw-cap-badge is-muted">
            {model.cost
              ? t("providers.models.badgeCost", { input: model.cost.input, output: model.cost.output })
              : t("providers.models.costUnknown")}
          </span>
        </>
      )}
    </span>
  );
}
