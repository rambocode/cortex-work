// 高级：Base URL 覆盖（自建网关 / 代理端点 / Azure resource 端点）。原属 ProviderDetailPanel，
// 供应商管理平铺进设置页后由 API Key 行与云平台折叠行复用，故独立成文件。
//
// 落盘在 main-owned 的 `provider-prefs.json`，主进程生成 pi extension 时用
// `getBaseUrlOverride(id) ?? provider.baseUrl` 取值，所以填了是**真的**会作用到请求上。
//
// 三条边界：
//   · 输入清空 = 传 `undefined` 清除覆盖、恢复 Catalog 内置端点（不是存一个空串）；
//   · 桥不支持（Web 端 / 旧壳）→ 禁用 + 说明，绝不做成「能填但不生效」；
//   · 草稿只在本地维护，保存后由 `status.baseUrlOverride` 回显——主进程才是真相。
//
// ── 为什么这里没有「保存」按钮 ──────────────────────────────────────────────
// 它曾经自带一个，于是一行里同屏出现两个都叫「保存」的按钮（另一个存 API Key），
// 写的却是两套存储（safeStorage vs provider-prefs.json），用户无从判断哪个提交了什么。
// 现在规则统一成「**每行恒一个保存按钮，提交该行全部未保存的改动**」：草稿状态由
// `useBaseUrlDraft` 交给行组件持有，本组件退化为纯展示字段。

import { useEffect, useState } from "react";
import { useTranslation } from "@cortex-work/core/i18n";
import { useProviderAuthActions } from "./useProviderData";

/** `useBaseUrlDraft` 返回的草稿句柄；行组件据此渲染字段并把 `commit` 并进自己的保存动作。 */
export interface BaseUrlDraft {
  draft: string;
  setDraft: (value: string) => void;
  /** 与主进程当前值不同 → 有待保存的改动。 */
  dirty: boolean;
  pending: boolean;
  /** 提交覆盖。失败（如地址非法）时 reject，调用方据此中止后续保存。 */
  commit: () => Promise<void>;
  /** 清除覆盖、恢复官方端点。 */
  clear: () => void;
}

/**
 * Base URL 覆盖的草稿状态。抽成 hook 是为了让「保存」这个动作能由行组件统一持有
 *（一行一个保存按钮），而字段本身仍可就地渲染。
 */
export function useBaseUrlDraft(providerId: string, override?: string): BaseUrlDraft {
  const { setBaseUrl } = useProviderAuthActions();
  const [draft, setDraft] = useState(override ?? "");

  // 覆盖值由主进程回读（保存成功后 auth 快照失效重取），据此同步草稿；
  // 用户正在编辑时不覆盖他的输入 —— 只在「远端值变了」时跟随。
  useEffect(() => {
    setDraft(override ?? "");
  }, [override]);

  const trimmed = draft.trim();
  // **空 = 不改动**，与同一配置区里的密钥输入框同一条规则：留空只是「这次不动它」，
  // 不代表「把它清空」。清除覆盖是显式动作，走下面的 clear（界面上是独立按钮）。
  // 曾经的语义是「空串 → 清除覆盖」，在「密钥 + 地址同屏、一个保存」的新形态下会变成陷阱：
  // 用户只想换密钥，却因为地址框空着而把自建网关地址一起清了。
  const dirty = !!trimmed && trimmed !== (override ?? "");

  return {
    draft,
    setDraft,
    dirty,
    pending: setBaseUrl.isPending,
    // 主进程用 `{ ok, error }` 表达失败而不是抛异常，这里翻译成 reject——
    // 行组件靠 throw 才能中止「先地址后密钥」的串行保存（地址非法时不该把密钥也存进去）。
    commit: async () => {
      if (!trimmed) return;
      const res = await setBaseUrl.mutateAsync({ providerId, baseUrl: trimmed });
      if (!res.ok) throw new Error(res.error ?? "保存失败");
    },
    clear: () => setBaseUrl.mutate({ providerId, baseUrl: undefined }),
  };
}

/**
 * 纯展示字段：标签 + 输入框。保存与「清除覆盖」都由行组件的动作区负责——
 * 字段自己不带任何提交/销毁按钮，才能让「一行一个保存」这条约定成立。
 */
export function BaseUrlOverride({
  catalogBaseUrl,
  supported,
  draft,
}: {
  catalogBaseUrl?: string;
  supported: boolean;
  draft: BaseUrlDraft;
}) {
  const { t } = useTranslation("settings");
  return (
    <>
      <label className="pw-set-field">
        <span className="pw-set-lbl">{t("providers.baseUrlOverride")}</span>
        <input
          className="pw-set-input"
          value={draft.draft}
          // placeholder 显示 Catalog 里的官方端点：让用户看清「留空会走哪儿」。
          placeholder={catalogBaseUrl || t("providers.baseUrlOverridePlaceholder")}
          spellCheck={false}
          disabled={!supported}
          onChange={(e) => draft.setDraft(e.target.value)}
        />
      </label>
      {!supported ? <div className="pw-set-hint">{t("providers.baseUrlOverrideUnavailable")}</div> : null}
    </>
  );
}
