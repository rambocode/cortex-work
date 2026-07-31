// 图片能力拦截提示条：当前模型不支持图片输入、或 Catalog 里查不到该模型（能力未知）时，
// send 拒发本轮并保留草稿，这里给出两个明确出路：换一个支持图片的模型 / 移除图片。
//
// 数据源：usePersonalStore.visionBlockHints[sessionId]（瞬态，由 messages.ts 的 send 写入）。
// 与 ModeBlockBanner 同位置、同视觉规格，但**语气与配色是警示**——这条不是「要不要切档」的
// 建议，而是「这轮真的没发出去」的事实告知。
//
// 三条不可让步的行为（计划 §2.3）：
//   1. 不自动换模型。用户点「选择支持图片的模型」才改 session，且候选只列真的支持图片的。
//   2. 不静默丢图。「移除图片」是显式动作，且只清空待发图，不动文本。
//   3. unsupported 与 unknown 文案必须不同——把「目录不知道」说成「不支持」会误导用户去换模型。

import { useProviderCatalog, usePersonalStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { useState } from "react";
import { ModelPickerDialog } from "../settings/provider/ModelPickerDialog";

export function VisionBlockBanner({
  sessionId,
  /** 清空 composer 里待发图片。由 ComposerShell 注入（待发图是它的内部状态）。 */
  onRemoveImages,
}: {
  sessionId: string;
  onRemoveImages?: () => void;
}) {
  const { t } = useTranslation("chat");
  const hint = usePersonalStore((s) => s.visionBlockHints[sessionId]);
  const setVisionBlockHint = usePersonalStore((s) => s.setVisionBlockHint);
  const updateSession = usePersonalStore((s) => s.updateSession);
  const { catalog } = useProviderCatalog();
  const [picking, setPicking] = useState(false);

  if (!hint) return null;

  // 模型展示名优先用 Catalog 里的 name（unsupported 时一定查得到）；unknown 时只有裸 id。
  const model = catalog?.providers
    .find((p) => p.id === hint.providerId)
    ?.models.find((m) => m.id === hint.modelId);
  const modelLabel = model?.name ?? hint.modelId ?? "";

  const messageKey = !hint.modelId
    ? "composer.visionBlock.unknownNoModel"
    : hint.reason === "unsupported"
      ? "composer.visionBlock.unsupported"
      : "composer.visionBlock.unknown";

  return (
    <>
      <div className="pw-mode-block is-warn" role="alert">
        <span className="pw-mode-block-text">{t(messageKey, { model: modelLabel })}</span>
        <div className="pw-mode-block-actions">
          <button type="button" className="pw-mode-block-btn primary" onClick={() => setPicking(true)}>
            {t("composer.visionBlock.pickModel")}
          </button>
          <button
            type="button"
            className="pw-mode-block-btn"
            onClick={() => {
              onRemoveImages?.();
              setVisionBlockHint(sessionId, undefined);
            }}
          >
            {t("composer.visionBlock.removeImages")}
          </button>
        </div>
      </div>
      {picking ? (
        <ModelPickerDialog
          // 只列支持图片的模型：用户是为了发图才来的，列出文本模型只会让他再撞一次墙。
          requireImage
          value={{ providerId: hint.providerId ?? "", modelId: hint.modelId ?? "" }}
          onClose={() => setPicking(false)}
          onSelect={(ref) => {
            updateSession(sessionId, { providerId: ref.providerId, model: ref.modelId });
            // 换成支持图片的模型 = 拦截理由消失，提示条即刻撤下（草稿仍在，用户直接重发）。
            setVisionBlockHint(sessionId, undefined);
            setPicking(false);
          }}
        />
      ) : null}
    </>
  );
}
