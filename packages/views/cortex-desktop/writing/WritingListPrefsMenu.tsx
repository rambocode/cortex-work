// 写作左栏「文稿列表」偏好菜单：排序键 / 升降序 + 显示项开关（创建时间、概要）。
// 纯受控组件：值与写入回调由 WritingSidebar 从 spaces store 注入；本组件只管弹层开合与点击外部关闭。
// 弹层定位：锚在标题行右侧按钮下方，右对齐 + max-height 滚动 —— 左栏窄且可能贴屏幕边，
// 用 right:0 而非 left 定位可避免向右溢出视口（这是本仓库反复踩过的浮层裁切问题）。
import { useEffect, useRef, useState, type ReactElement } from "react";
import { ArrowDownAZ, Check, ListFilter } from "lucide-react";
import type { WritingDocSortKey, WritingDocSortOrder } from "@cortex-work/core/writing/spaces";

const SORT_KEYS: { key: WritingDocSortKey; label: string }[] = [
  { key: "name", label: "文件名" },
  { key: "created", label: "创建时间" },
  { key: "updated", label: "修改时间" },
];

const SORT_ORDERS: { order: WritingDocSortOrder; label: string }[] = [
  { order: "asc", label: "升序" },
  { order: "desc", label: "降序" },
];

export function WritingListPrefsMenu({
  sortKey,
  sortOrder,
  showCreatedAt,
  showExcerpt,
  metaSupported,
  onSort,
  onToggleCreatedAt,
  onToggleExcerpt,
}: {
  sortKey: WritingDocSortKey;
  sortOrder: WritingDocSortOrder;
  showCreatedAt: boolean;
  showExcerpt: boolean;
  // 宿主壳是否支持取文稿元信息（web/旧壳为 false）：不支持时时间/概要与按时间排序不可用，置灰并说明原因。
  metaSupported: boolean;
  onSort: (key: WritingDocSortKey, order: WritingDocSortOrder) => void;
  onToggleCreatedAt: (show: boolean) => void;
  onToggleExcerpt: (show: boolean) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 点击弹层外部 / Esc 关闭。挂在 document 上用捕获期，避免被行内 stopPropagation 吞掉。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="pw-writing-listprefs" ref={wrapRef}>
      <button
        type="button"
        className="pw-writing-head-btn"
        title="排序与显示"
        aria-label="排序与显示"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ArrowDownAZ size={14} strokeWidth={1.75} />
      </button>
      {open ? (
        <div className="pw-writing-listprefs-menu" role="menu">
          <div className="pw-writing-listprefs-title">排序方式</div>
          {SORT_KEYS.map((item) => {
            // 按时间排序依赖元信息通道；不支持时禁用（否则点了没反应更困惑）。
            const disabled = item.key !== "name" && !metaSupported;
            return (
              <button
                key={item.key}
                type="button"
                role="menuitemradio"
                aria-checked={sortKey === item.key}
                className={`pw-writing-listprefs-item${sortKey === item.key ? " is-on" : ""}`}
                disabled={disabled}
                title={disabled ? "当前环境不支持读取文件时间" : undefined}
                onClick={() => onSort(item.key, sortOrder)}
              >
                <span className="pw-writing-listprefs-check">
                  {sortKey === item.key ? <Check size={13} strokeWidth={2} /> : null}
                </span>
                <span>{item.label}</span>
              </button>
            );
          })}

          <div className="pw-writing-listprefs-sep" />
          <div className="pw-writing-listprefs-title">顺序</div>
          {SORT_ORDERS.map((item) => (
            <button
              key={item.order}
              type="button"
              role="menuitemradio"
              aria-checked={sortOrder === item.order}
              className={`pw-writing-listprefs-item${sortOrder === item.order ? " is-on" : ""}`}
              onClick={() => onSort(sortKey, item.order)}
            >
              <span className="pw-writing-listprefs-check">
                {sortOrder === item.order ? <Check size={13} strokeWidth={2} /> : null}
              </span>
              <span>{item.label}</span>
            </button>
          ))}

          <div className="pw-writing-listprefs-sep" />
          <div className="pw-writing-listprefs-title">
            <ListFilter size={12} strokeWidth={1.8} />
            <span>列表显示</span>
          </div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={showCreatedAt}
            className={`pw-writing-listprefs-item${showCreatedAt ? " is-on" : ""}`}
            disabled={!metaSupported}
            title={!metaSupported ? "当前环境不支持读取文件时间" : undefined}
            onClick={() => onToggleCreatedAt(!showCreatedAt)}
          >
            <span className="pw-writing-listprefs-check">
              {showCreatedAt ? <Check size={13} strokeWidth={2} /> : null}
            </span>
            <span>显示创建时间</span>
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={showExcerpt}
            className={`pw-writing-listprefs-item${showExcerpt ? " is-on" : ""}`}
            disabled={!metaSupported}
            title={!metaSupported ? "当前环境不支持读取文档正文" : undefined}
            onClick={() => onToggleExcerpt(!showExcerpt)}
          >
            <span className="pw-writing-listprefs-check">
              {showExcerpt ? <Check size={13} strokeWidth={2} /> : null}
            </span>
            <span>显示概要（50 字内）</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
