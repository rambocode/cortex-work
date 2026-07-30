// @mention 自动完成弹窗：用户在 Composer 输入 @ 后展示可选的内置 agent 和自定义角色。
// 选中后把 @mention 文本插入到光标位置，完成后关闭弹窗。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersonalStore } from "@cortex-work/core/store/personal";
import { BUILTIN_ROLES } from "@cortex-work/core/personal/mention";
import type { RoleConfig } from "@cortex-work/core/desktop/types";

export interface MentionOption {
  id: string;
  label: string;
  agent: string;
  color?: string;
  avatar?: string;
  builtin?: boolean;
}

// 从 store roles + 内置角色组装可选列表。
export function useMentionOptions(): MentionOption[] {
  const roles = usePersonalStore((s) => s.roles);
  return useMemo(() => {
    const builtins: MentionOption[] = Object.values(BUILTIN_ROLES).map((b) => ({
      id: b.id,
      label: b.label,
      agent: b.agent,
      builtin: true,
    }));
    const custom: MentionOption[] = roles.map((r: RoleConfig) => ({
      id: r.id,
      label: r.label,
      agent: r.agent,
      color: r.color,
      avatar: r.avatar,
    }));
    return [...builtins, ...custom];
  }, [roles]);
}

// 从文本 + 光标位置提取正在输入的 @query（@ 后到光标的文字）。
// 返回 null 表示不在 @mention 上下文中。
export function extractMentionQuery(
  text: string,
  cursorPos: number,
): { query: string; start: number } | null {
  const before = text.slice(0, cursorPos);
  // 从光标往回找最近的 @，中间不能有空白或换行
  const match = before.match(/@([^\s@]*)$/);
  if (!match) return null;
  return { query: match[1]!.toLowerCase(), start: cursorPos - match[1]!.length - 1 };
}

// 筛选匹配项
export function filterMentionOptions(options: MentionOption[], query: string): MentionOption[] {
  if (!query) return options;
  const q = query.toLowerCase();
  return options.filter(
    (o) => o.label.toLowerCase().includes(q) || o.id.toLowerCase().includes(q),
  );
}

// 将选中的 mention 插入文本：替换 @query 为无空白 id 并加一个空格。
export function applyMention(
  text: string,
  start: number,
  cursorPos: number,
  option: Pick<MentionOption, "id" | "label">,
): { newText: string; newCursor: number } {
  const replacement = `@${option.id} `;
  const newText = text.slice(0, start) + replacement + text.slice(cursorPos);
  return { newText, newCursor: start + replacement.length };
}

export function MentionDropdown({
  options,
  activeIndex,
  onSelect,
  anchorRect,
}: {
  options: MentionOption[];
  activeIndex: number;
  onSelect: (option: MentionOption) => void;
  anchorRect: { left: number; bottom: number } | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  if (!options.length || !anchorRect) return null;

  return (
    <div
      ref={listRef}
      className="pw-mention-dropdown"
      style={{ left: anchorRect.left, bottom: anchorRect.bottom }}
    >
      {options.map((opt, i) => (
        <button
          key={opt.id}
          type="button"
          className={`pw-mention-item ${i === activeIndex ? "is-active" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(opt);
          }}
        >
          {opt.avatar ? (
            <span className="pw-mention-avatar">{opt.avatar}</span>
          ) : (
            <span
              className="pw-mention-avatar pw-mention-avatar-dot"
              style={opt.color ? { background: opt.color } : undefined}
            />
          )}
          <span className="pw-mention-label" style={opt.color ? { color: opt.color } : undefined}>
            @{opt.label}
          </span>
          <span className="pw-mention-agent">{opt.agent}</span>
          {opt.builtin && <span className="pw-mention-builtin">built-in</span>}
        </button>
      ))}
    </div>
  );
}

// hook: 管理 mention autocomplete 状态，接入 textarea ref。
export function useMentionAutocomplete(
  text: string,
  setText: (v: string | ((prev: string) => string)) => void,
  taRef: React.RefObject<HTMLTextAreaElement | null>,
) {
  const allOptions = useMentionOptions();
  const [mentionState, setMentionState] = useState<{
    query: string;
    start: number;
    cursorPos: number;
  } | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [anchorRect, setAnchorRect] = useState<{ left: number; bottom: number } | null>(null);

  const filtered = useMemo(
    () => (mentionState ? filterMentionOptions(allOptions, mentionState.query) : []),
    [allOptions, mentionState],
  );

  const updateMentionState = useCallback(() => {
    const ta = taRef.current;
    if (!ta) { setMentionState(null); return; }
    const cursorPos = ta.selectionStart;
    const result = extractMentionQuery(ta.value, cursorPos);
    if (result) {
      setMentionState({ ...result, cursorPos });
      setActiveIdx(0);
      // 近似弹窗定位：textarea 左上角 + 固定偏移
      const rect = ta.getBoundingClientRect();
      setAnchorRect({ left: rect.left, bottom: window.innerHeight - rect.top + 4 });
    } else {
      setMentionState(null);
    }
  }, [taRef]);

  // 选中 mention 项
  const selectMention = useCallback(
    (opt: MentionOption) => {
      if (!mentionState) return;
      const { newText, newCursor } = applyMention(
        text, mentionState.start, mentionState.cursorPos, opt,
      );
      setText(newText);
      setMentionState(null);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) {
          ta.selectionStart = newCursor;
          ta.selectionEnd = newCursor;
          ta.focus();
        }
      });
    },
    [mentionState, text, setText, taRef],
  );

  // 拦截键盘事件：弹窗打开时 ↑↓ 导航、Enter/Tab 选中、Escape 关闭。
  // 返回 true 表示已消费此事件，调用方不要继续处理。
  const handleMentionKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!mentionState || !filtered.length) return false;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setActiveIdx((i) => (i + 1) % filtered.length);
          return true;
        case "ArrowUp":
          e.preventDefault();
          setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
          return true;
        case "Enter":
        case "Tab":
          e.preventDefault();
          selectMention(filtered[activeIdx]!);
          return true;
        case "Escape":
          e.preventDefault();
          setMentionState(null);
          return true;
        default:
          return false;
      }
    },
    [mentionState, filtered, activeIdx, selectMention],
  );

  const isOpen = !!mentionState && filtered.length > 0;

  return {
    isOpen,
    filtered,
    activeIdx,
    anchorRect,
    updateMentionState,
    handleMentionKeyDown,
    selectMention,
  };
}
