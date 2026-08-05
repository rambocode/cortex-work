// 设置 → 宠物。从 SettingsMenu 抽出(那个文件已逼近单文件 1200 行上限)。
//
// 图鉴做成这里的一个抽屉而不是独立工作区视图:这是「选一只宠物」的设置行为,
// 不是需要与会话/写作/研究并列的工作台。参考实现把它做成整页,只是因为它没有全页设置。

import { useCallback, useEffect, useState } from "react";
import { useDesktopBridge, usePetStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import type { PetdexCacheStats, PetdexEntry } from "@cortex-work/core/desktop/petdex-types";
import { PetCanvas } from "../../pet/PetCanvas";
import { PetdexGallery } from "../../pet/petdex/PetdexGallery";
import { createPetdexSource } from "../../pet/petdexSource";
import { PET_SIZE_MAX, PET_SIZE_MIN, patchPetPrefs } from "../../pet/prefs";
import { builtinSpriteSource } from "../../pet/sheets";
import { SBlock, SRow, SettingCard, SwitchRow } from "./settingsControls";

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PetSettingsSection() {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const sprite = usePetStore((s) => s.sprite);
  const enabled = usePetStore((s) => s.enabled);
  const size = usePetStore((s) => s.size);

  const [galleryOpen, setGalleryOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [cache, setCache] = useState<PetdexCacheStats | null>(null);

  const refreshCache = useCallback(() => {
    if (!bridge?.petdex) return;
    void bridge.petdex.cacheStats().then(setCache).catch(() => setCache(null));
  }, [bridge]);

  useEffect(refreshCache, [refreshCache]);

  const pick = async (entry: PetdexEntry) => {
    setPicking(true);
    try {
      const next = await createPetdexSource(bridge).resolveSprite(entry.slug, entry.displayName);
      if (!next) return; // 下载失败:保持当前宠物,别把用户已有的换没了
      patchPetPrefs({ slug: entry.slug });
      usePetStore.getState().setSprite(next);
      setGalleryOpen(false);
      refreshCache();
    } finally {
      setPicking(false);
    }
  };

  const useBuiltin = () => {
    patchPetPrefs({ slug: null });
    usePetStore.getState().setSprite(builtinSpriteSource());
  };

  const clearCache = () => {
    if (!bridge?.petdex) return;
    void bridge.petdex.clearCache().then(setCache);
  };

  const currentSlug = sprite?.origin === "petdex" ? sprite.id : null;

  return (
    <>
      <div className="pw-dlg-title">{t("pet.title")}</div>
      <div className="pw-dlg-desc">{t("pet.desc")}</div>

      <SettingCard title={t("pet.cardTitle")}>
        <SwitchRow
          label={t("pet.showPet")}
          value={enabled}
          onChange={(v: boolean) => patchPetPrefs({ enabled: v })}
        />
      </SettingCard>

      <SettingCard title={t("pet.appearanceCard")}>
        <SBlock label={t("pet.design")}>
          <div className="pw-pet-current">
            {/* 预览复用宠物本体的渲染器(frozen = 只画第 0 帧),所见即所得。 */}
            <span className="pet-preview">
              <PetCanvas sprite={sprite} state="idle" width={84} frozen />
            </span>
            <div className="pw-pet-current-meta">
              <div className="pw-pet-name">{sprite?.displayName ?? ""}</div>
              <div className="pw-pet-desc">
                {sprite?.origin === "petdex" ? t("pet.fromPetdex") : t("pet.fromBuiltin")}
              </div>
            </div>
            <div className="pw-pet-current-actions">
              <button type="button" onClick={() => setGalleryOpen((v) => !v)} disabled={picking}>
                {galleryOpen ? t("pet.galleryClose") : t("pet.change")}
              </button>
              {currentSlug ? (
                <button type="button" className="pw-pet-reset" onClick={useBuiltin}>
                  {t("pet.useBuiltin")}
                </button>
              ) : null}
            </div>
          </div>
          <PetdexGallery
            open={galleryOpen}
            currentSlug={currentSlug}
            onPick={(entry) => void pick(entry)}
            onClose={() => setGalleryOpen(false)}
          />
        </SBlock>

        <SRow label={t("pet.size")}>
          <div className="pw-pet-size">
            <input
              type="range"
              min={PET_SIZE_MIN}
              max={PET_SIZE_MAX}
              step={0.05}
              value={size}
              onChange={(e) => patchPetPrefs({ size: Number(e.target.value) })}
              aria-label={t("pet.sizeAria")}
            />
            <span className="pw-pet-size-val">{Math.round(size * 100)}%</span>
            {size !== 1 ? (
              <button className="pw-pet-reset" onClick={() => patchPetPrefs({ size: 1 })}>
                {t("pet.reset")}
              </button>
            ) : null}
          </div>
        </SRow>

        {/* 缓存行只在桌面端出现:Web 直连 petdex,没有本地缓存可言。 */}
        {bridge?.petdex ? (
          <SRow label={t("pet.cache")}>
            <div className="pw-pet-cache">
              <span>{t("pet.cacheStat", { count: cache?.entries ?? 0, size: formatMB(cache?.bytes ?? 0) })}</span>
              <button type="button" className="pw-pet-reset" onClick={clearCache} disabled={!cache?.entries}>
                {t("pet.clearCache")}
              </button>
            </div>
          </SRow>
        ) : null}
      </SettingCard>
    </>
  );
}
