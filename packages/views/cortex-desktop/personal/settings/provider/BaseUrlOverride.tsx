// 高级：Base URL 覆盖（自建网关 / 代理端点 / Azure resource 端点）。原属 ProviderDetailPanel，
// 供应商管理平铺进设置页后由云平台折叠行复用，故独立成文件。
//
// 落盘在 main-owned 的 `provider-prefs.json`，主进程生成 pi extension 时用
// `getBaseUrlOverride(id) ?? provider.baseUrl` 取值，所以填了是**真的**会作用到请求上。
//
// 三条边界：
//   · 输入清空 = 传 `undefined` 清除覆盖、恢复 Catalog 内置端点（不是存一个空串）；
//   · 桥不支持（Web 端 / 旧壳）→ 禁用 + 说明，绝不做成「能填但不生效」；
//   · 草稿只在本地维护，保存后由 `status.baseUrlOverride` 回显——主进程才是真相。

import { useEffect, useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import { useProviderAuthActions } from "./useProviderData";

export function BaseUrlOverride({
  providerId,
  catalogBaseUrl,
  override,
  supported,
}: {
  providerId: string;
  catalogBaseUrl?: string;
  override?: string;
  supported: boolean;
}) {
  const { t } = useTranslation("settings");
  const { setBaseUrl } = useProviderAuthActions();
  const [draft, setDraft] = useState(override ?? "");
  const [savedTick, setSavedTick] = useState(false);

  // 覆盖值由主进程回读（保存成功后 auth 快照失效重取），据此同步草稿；
  // 用户正在编辑时不覆盖他的输入 —— 只在「远端值变了且与草稿不同」时跟随。
  useEffect(() => {
    setDraft(override ?? "");
    setSavedTick(false);
  }, [override]);

  const trimmed = draft.trim();
  const dirty = trimmed !== (override ?? "");

  return (
    <>
      <label className="pw-set-field">
        <span className="pw-set-lbl">{t("providers.baseUrlOverride")}</span>
        <input
          className="pw-set-input"
          value={draft}
          // placeholder 显示 Catalog 里的官方端点：让用户看清「留空会走哪儿」。
          placeholder={catalogBaseUrl || t("providers.baseUrlOverridePlaceholder")}
          spellCheck={false}
          disabled={!supported}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
      {supported ? (
        <div className="pw-mode-block-actions">
          <button
            type="button"
            className="pw-mode-block-btn primary"
            disabled={!dirty || setBaseUrl.isPending}
            onClick={() =>
              setBaseUrl.mutate(
                // 空串 → undefined：语义是「清除覆盖」，而不是「把端点设成空」。
                { providerId, baseUrl: trimmed || undefined },
                { onSuccess: () => setSavedTick(true) },
              )
            }
          >
            {savedTick && !dirty ? t("providers.apiKeySaved") : t("providers.baseUrlOverrideSave")}
          </button>
          {override ? (
            <button
              type="button"
              className="pw-mode-block-btn"
              disabled={setBaseUrl.isPending}
              onClick={() => setBaseUrl.mutate({ providerId, baseUrl: undefined })}
            >
              {t("providers.baseUrlOverrideClear")}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="pw-set-hint">{t("providers.baseUrlOverrideUnavailable")}</div>
      )}
    </>
  );
}
