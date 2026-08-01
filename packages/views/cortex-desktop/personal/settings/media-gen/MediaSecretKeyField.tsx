// 媒体生成密钥金库控件——「明文不落 store」的 API Key 输入（替代旧 SecretField）。
//
// 红线（见 core/desktop/media-gen-types.ts 头注释）：personal-workspace.json 会被 renderer
// 全量读写过桥，settings.apiKey 只允许空串或 ${secret:NAME} 金库引用。因此本控件：
//   · 明文只活在组件本地 state（draft），保存成功后立即清空，绝不回显；
//   · 保存链路：providerAuthSetSecrets({ [secretName]: 明文 }) 先落主进程金库
//     （safeStorage 加密），成功后才经 onChange 把 "${secret:NAME}" 引用写回 store——
//     顺序刻意：金库失败时 store 不动，不会出现「引用存在但金库无值」的悬空态；
//   · 清除链路：setSecrets 空串（=删除该 Secret）+ apiKey 置空；
//   · 金库不可用（safeStorage 降级）→ 禁输入并展示 health.reason；
//   · 桥方法缺失（Web 端/旧壳）→ unsupported 降级文案（useProviderData 惯例）。

import { useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import { useDesktopBridge } from "@cortex-work/core";

import { SRow } from "../settingsControls";
import { useProviderAuth, useProviderAuthActions } from "../provider/useProviderData";

export function MediaSecretKeyField({
  secretName,
  value,
  onChange,
}: {
  /** 金库命名 Secret 名（custom 态用 mediaCustomSecretName(modality)，standalone 用目录 entry.secretName）。*/
  secretName: string;
  /** settings.apiKey 现值：空串 / ${secret:NAME} 引用 /（迁移窗口期）历史明文。*/
  value: string;
  /** 写回 settings.apiKey——只会收到空串或 ${secret:NAME} 引用，绝不明文。*/
  onChange: (v: string) => void;
}) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const { snapshot } = useProviderAuth();
  const { setSecrets } = useProviderAuthActions();

  // 明文草稿只存在于这里；editing 表示「已保存态下点了更换」。
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // 桥缺失：媒体密钥金库仅桌面端可用，Web/旧壳渲染降级文案不白屏。
  if (!bridge?.providerAuthSetSecrets) {
    return (
      <SRow label={t("mediaGen.apiKeyLabel")} end>
        <span className="pw-set-hint">{t("mediaGen.apiKeyUnsupported")}</span>
      </SRow>
    );
  }

  const vaultDown = snapshot.health.available === false;
  // 引用与迁移期历史明文一律按「已保存」处理：不回显任何既有值（明文也不能回显——
  // 它即将被首启迁移搬进金库，UI 提前按密文对待）。
  const saved = value.trim().length > 0;

  const save = async () => {
    const plain = draft.trim();
    if (!plain) return;
    const res = await setSecrets.mutateAsync({ [secretName]: plain });
    if (res.ok) {
      onChange(`\${secret:${secretName}}`);
      setDraft("");
      setEditing(false);
      setError(undefined);
    } else {
      setError(res.error ?? "unknown");
    }
  };

  const clear = async () => {
    // 空串 = 删除该命名 Secret（providerAuthSetSecrets 契约）。
    const res = await setSecrets.mutateAsync({ [secretName]: "" });
    if (res.ok) {
      onChange("");
      setDraft("");
      setEditing(false);
      setError(undefined);
    } else {
      setError(res.error ?? "unknown");
    }
  };

  if (vaultDown) {
    return (
      <SRow label={t("mediaGen.apiKeyLabel")} end>
        <span className="pw-set-hint" role="status">
          {t("mediaGen.apiKeyVaultUnavailable", { reason: snapshot.health.reason ?? "" })}
        </span>
      </SRow>
    );
  }

  if (saved && !editing) {
    return (
      <SRow label={t("mediaGen.apiKeyLabel")} end>
        <span className="pw-secret-wrap">
          <span className="pw-set-hint">{t("mediaGen.apiKeySavedBadge")}</span>
          <button type="button" className="pw-mode-block-btn" onClick={() => setEditing(true)}>
            {t("mediaGen.apiKeyReplaceAction")}
          </button>
          <button type="button" className="pw-mode-block-btn" onClick={() => void clear()}>
            {t("mediaGen.apiKeyClearAction")}
          </button>
        </span>
      </SRow>
    );
  }

  return (
    <SRow label={t("mediaGen.apiKeyLabel")} end>
      <span className="pw-secret-wrap">
        <input
          className="pw-set-input"
          type="password"
          value={draft}
          placeholder="sk-..."
          spellCheck={false}
          autoComplete="off"
          aria-label={t("mediaGen.apiKeyLabel")}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="pw-mode-block-btn primary"
          disabled={!draft.trim() || setSecrets.isPending}
          onClick={() => void save()}
        >
          {t("mediaGen.apiKeySaveAction")}
        </button>
        {saved ? (
          <button
            type="button"
            className="pw-mode-block-btn"
            onClick={() => {
              setEditing(false);
              setDraft("");
              setError(undefined);
            }}
          >
            {t("mediaGen.apiKeyCancelAction")}
          </button>
        ) : null}
      </span>
      {error ? (
        <span className="pw-prov-alert is-warn" role="alert">
          {t("mediaGen.apiKeySaveError", { error })}
        </span>
      ) : null}
    </SRow>
  );
}
