// 全局共享的模型选择器（计划 §4.2）。Chat、Research、Reply、Automation、workflow AI 节点、
// Computer Use **全部复用这一个组件**——各处自己写一份下拉正是「能力认知漂移」的温床。
//
// 候选集规则（唯一真相在 useProviderData.collectModelOptions）：
//   认证可用 ∧ 用户未隐藏；`requireImage` 时再收窄到 input 含 image（Computer Use 必须看得见屏幕）。
// 能力徽标只读，来自 Catalog；这里没有任何「用户声明能力」的入口。
//
// 无障碍：搜索框自动聚焦，↑/↓ 移动高亮、Enter 选中、Esc 关闭，全流程可纯键盘完成。

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useTranslation } from "@cortex-work/core/i18n";
import type { ModelRef } from "@cortex-work/core/desktop/provider-catalog";
import { CapabilityBadges } from "./capabilityFormat";
import { collectModelOptions, filterModelOptions, useProviderViews, type ModelOption } from "./useProviderData";

export function ModelPicker({
  value,
  onSelect,
  requireImage,
  onOpenManager,
  autoFocus = true,
}: {
  value?: ModelRef;
  onSelect: (ref: ModelRef) => void;
  /** 只列支持图片输入的模型。Computer Use 与「换个能收图的模型」场景用。 */
  requireImage?: boolean;
  /** 空态时「去供应商管理」的跳转。不传则不渲染该按钮。 */
  onOpenManager?: () => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation("settings");
  const { views, loading, catalogError, catalogUnsupported } = useProviderViews();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => collectModelOptions(views, requireImage), [views, requireImage]);
  const filtered = useMemo(() => filterModelOptions(options, query), [options, query]);

  // 搜索变化后高亮回到首项，避免游标停在已被过滤掉的位置。
  useEffect(() => setCursor(0), [query]);
  // 高亮项滚进可视区（纯键盘操作时列表不会跟不上游标）。
  // jsdom 不实现 scrollIntoView，故做能力探测——纯展示行为，缺了不影响功能。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="1"]');
    if (typeof el?.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [cursor, filtered.length]);

  if (catalogUnsupported) return <div className="pw-set-hint">{t("providers.catalogUnsupported")}</div>;
  if (catalogError) return <div className="pw-prov-alert is-error">{t("providers.catalogUnavailable", { error: catalogError })}</div>;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (e.key === "Enter") {
      const opt = filtered[cursor];
      if (opt) {
        e.preventDefault();
        onSelect({ providerId: opt.providerId, modelId: opt.modelId });
      }
    }
  };

  return (
    <div className="pw-model-picker">
      <label className="pw-model-picker-search">
        <Icon.Search size={13} />
        <input
          className="pw-set-input"
          value={query}
          placeholder={t("providers.picker.search")}
          spellCheck={false}
          autoFocus={autoFocus}
          aria-label={t("providers.picker.search")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </label>
      {requireImage ? <div className="pw-set-hint">{t("providers.picker.requireImageHint")}</div> : null}

      {loading ? <div className="pw-set-hint">{t("providers.catalogLoading")}</div> : null}

      {!loading && options.length === 0 ? (
        <div className="pw-prov-empty">
          <span>{requireImage ? t("providers.picker.emptyImage") : t("providers.picker.empty")}</span>
          {onOpenManager ? (
            <button type="button" className="pw-mode-block-btn primary" onClick={onOpenManager}>
              {t("providers.picker.openManager")}
            </button>
          ) : null}
        </div>
      ) : null}

      {!loading && options.length > 0 && filtered.length === 0 ? (
        <div className="pw-set-hint">{t("providers.picker.noResult")}</div>
      ) : null}

      <div className="pw-model-picker-list" role="listbox" aria-label={t("providers.picker.title")} ref={listRef}>
        {filtered.map((o, i) => (
          <ModelRow
            key={`${o.providerId}::${o.modelId}`}
            option={o}
            active={i === cursor}
            selected={value?.providerId === o.providerId && value?.modelId === o.modelId}
            onHover={() => setCursor(i)}
            onSelect={() => onSelect({ providerId: o.providerId, modelId: o.modelId })}
          />
        ))}
      </div>
    </div>
  );
}

function ModelRow({
  option,
  active,
  selected,
  onHover,
  onSelect,
}: {
  option: ModelOption;
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      data-active={active ? "1" : "0"}
      className={`pw-model-picker-row ${active ? "is-active" : ""} ${selected ? "is-selected" : ""}`}
      onMouseEnter={onHover}
      onClick={onSelect}
    >
      <span className="pw-model-picker-main">
        <span className="pw-model-picker-name">{option.model.name}</span>
        <span className="pw-model-picker-meta">
          {option.providerName} · {option.modelId}
        </span>
      </span>
      <CapabilityBadges model={option.model} compact />
      {selected ? <Icon.Check size={13} /> : null}
    </button>
  );
}
