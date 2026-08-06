// 宠物图鉴选择器(petdex.dev,实测 4374 只)。
//
// 为什么是分页而不是无限滚动/虚拟列表:petdex 没有缩略图端点,每张卡的图就是**完整的
// sprite sheet**(1.2~2.5MB),一页 24 张已经是约 40MB 网络。无限滚动会让用户在毫不知情
// 的情况下拉爆流量;分页把每次的代价钉死且可预期。卡片只画第 0 帧、不播动画(24 个
// 动画同时跑会掉帧),hover 才起播。

import { useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import type { PetdexEntry } from "@cortex-work/core/desktop/petdex-types";
import { PetdexCard } from "./PetdexCard";
import {
  PAGE_SIZE,
  filterPets,
  pageCount,
  pageOf,
  samplePets,
  usePetdexManifest,
  type PetdexKindFilter,
} from "./usePetdexManifest";

const KINDS: PetdexKindFilter[] = ["all", "character", "creature", "object"];

export interface PetdexGalleryProps {
  open: boolean;
  /** 当前选中的 slug;null = 用的是内置角色。 */
  currentSlug: string | null;
  onPick: (entry: PetdexEntry) => void;
  onClose: () => void;
}

export function PetdexGallery({ open, currentSlug, onPick, onClose }: PetdexGalleryProps) {
  const { t } = useTranslation("settings");
  const bridge = useDesktopBridge();
  const { pets, stale, loading, error, reload } = usePetdexManifest(bridge, open);

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<PetdexKindFilter>("all");
  const [page, setPage] = useState(0);
  // 递增的取样种子:「换一批」靠它推进,不依赖 Math.random 的调用时机,结果可复现。
  const [seed, setSeed] = useState(1);
  const browsing = query.trim() !== "" || kind !== "all";

  const filtered = useMemo(() => filterPets(pets, { query, kind }), [pets, query, kind]);
  // 没有任何筛选条件时展示随机一批:4374 只按名字翻 183 页没有意义。
  const shown = useMemo(
    () => (browsing ? pageOf(filtered, page) : samplePets(filtered, PAGE_SIZE, seed)),
    [browsing, filtered, page, seed],
  );
  const total = pageCount(filtered.length);

  if (!open) return null;

  return (
    <div className="pw-petdex" role="dialog" aria-label={t("pet.galleryTitle")}>
      <div className="pw-petdex-bar">
        <input
          className="pw-set-input pw-petdex-search"
          value={query}
          placeholder={t("pet.searchPlaceholder")}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
        />
        <div className="pw-petdex-kinds">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={kind === k ? "is-active" : ""}
              onClick={() => {
                setKind(k);
                setPage(0);
              }}
            >
              {t(`pet.kind_${k}`)}
            </button>
          ))}
        </div>
        <button type="button" className="pw-petdex-close" onClick={onClose} aria-label={t("pet.galleryClose")}>
          <Icon.X size={14} />
        </button>
      </div>

      {stale ? <div className="pw-petdex-note is-stale">{t("pet.offlineNote")}</div> : null}
      {error ? (
        <div className="pw-petdex-note is-error">
          {t("pet.loadFailed")}
          <button type="button" onClick={() => reload(true)}>
            {t("pet.retry")}
          </button>
        </div>
      ) : null}

      {loading && pets.length === 0 ? (
        <div className="pw-petdex-note">{t("pet.loading")}</div>
      ) : shown.length === 0 ? (
        <div className="pw-petdex-note">{t("pet.noResult")}</div>
      ) : (
        <div className="pw-petdex-grid">
          {shown.map((entry) => (
            <PetdexCard
              key={entry.slug}
              entry={entry}
              active={entry.slug === currentSlug}
              onPick={() => onPick(entry)}
            />
          ))}
        </div>
      )}

      <div className="pw-petdex-foot">
        {browsing ? (
          <>
            <button type="button" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              {t("pet.prevPage")}
            </button>
            <span className="pw-petdex-page">{t("pet.pageOf", { page: page + 1, total })}</span>
            <button type="button" disabled={page >= total - 1} onClick={() => setPage((p) => p + 1)}>
              {t("pet.nextPage")}
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setSeed((s) => s + 1)}>
            {t("pet.shuffle")}
          </button>
        )}
        <span className="pw-petdex-total">{t("pet.totalCount", { count: filtered.length })}</span>
      </div>
    </div>
  );
}
