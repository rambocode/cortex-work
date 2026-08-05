// 供应商行的「唯一保存」动作：把 API Key 草稿与 Base URL 覆盖草稿合并成一次提交。
//
// 存在的理由是一条界面约定：**每行最多一个保存按钮，它提交该行全部未保存的改动**。
// 此前 API Key 与 Base URL 各自带一个按钮，两个都叫「保存」、写的却是两套存储
//（safeStorage vs provider-prefs.json），同屏出现时用户无从判断哪个提交了什么。

import { useState } from "react";
import type { BaseUrlDraft } from "./BaseUrlOverride";
import { useProviderAuthActions } from "./useProviderData";

export interface ProviderRowSave {
  keyDraft: string;
  setKeyDraft: (value: string) => void;
  /** 有任一处脏改动且不在提交中。 */
  canSave: boolean;
  saving: boolean;
  /** 上一次提交的失败原因（就地显示，不弹 toast）。 */
  error: string;
  save: () => void;
}

export function useProviderRowSave(providerId: string, baseUrl: BaseUrlDraft): ProviderRowSave {
  const { setApiKey } = useProviderAuthActions();
  const [keyDraft, setKeyDraft] = useState("");
  const [error, setError] = useState("");

  const trimmedKey = keyDraft.trim();
  const saving = setApiKey.isPending || baseUrl.pending;

  const save = () => {
    setError("");
    void (async () => {
      try {
        // 顺序不可调换：主进程会拒收非法地址并抛错，先提交地址才能在失败时**中止**后续密钥写入。
        // 反过来则会留下「密钥已存、地址没存」的半成品——请求照样发去官方端点，最难查。
        if (baseUrl.dirty) await baseUrl.commit();
        if (trimmedKey) {
          const res = await setApiKey.mutateAsync({ providerId, apiKey: trimmedKey });
          if (!res.ok) throw new Error(res.error ?? "保存失败");
          // 保存即清空草稿：明文不在 renderer 内存里多留一秒。
          setKeyDraft("");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  };

  return {
    keyDraft,
    setKeyDraft,
    canSave: (!!trimmedKey || baseUrl.dirty) && !saving,
    saving,
    error,
    save,
  };
}
