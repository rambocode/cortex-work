// 设置页「修改后自动保存」反馈 pill：订阅设置类 store 切片引用变化（personal 设置切片 +
// UI tweaks + 宠物设置）,任一变化即视为一次自动保存,顶部右侧浮出「已自动保存 ✓」,
// 短暂停留后淡出;连续修改重置计时。会话/消息等切片不在监听列表,避免无关更新误触发。
import { useEffect, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore, usePersonalStore, usePetStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";

// 展示时长（毫秒）：足够扫读,又不至于常驻遮挡。
const HIDE_DELAY_MS = 2000;

// 监听的 personal store 设置切片（引用对比;会话/任务/消息等切片刻意排除）。
const PERSONAL_KEYS = [
  "profile",
  "generalSettings",
  "providerSettings",
  "pushSettings",
  "ttsSettings",
  "mediaGenSettings",
  "designSettings",
  "asrSettings",
  "writingLlmSettings",
] as const;

export function SettingsSavedIndicator() {
  const { t } = useTranslation("settings");
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const notify = () => {
      setVisible(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
    };
    // 首帧快照在 subscribe 注册时由 zustand 提供 prevState,无需手动跳过 hydration。
    const unsubs = [
      usePersonalStore.subscribe((s, prev) => {
        if (PERSONAL_KEYS.some((k) => s[k] !== prev[k])) notify();
      }),
      useCortexUIStore.subscribe((s, prev) => {
        if (s.tweaks !== prev.tweaks) notify();
      }),
      usePetStore.subscribe((s, prev) => {
        if (s.kind !== prev.kind || s.enabled !== prev.enabled || s.size !== prev.size) notify();
      }),
    ];
    return () => {
      unsubs.forEach((u) => u());
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className={`pw-settings-saved${visible ? " is-visible" : ""}`} role="status" aria-live="polite">
      {visible ? (
        <>
          <Icon.Check size={12} />
          <span>{t("page.autoSaved")}</span>
        </>
      ) : null}
    </div>
  );
}
