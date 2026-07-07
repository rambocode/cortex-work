// 写作助手 composer 的 slash skill 提示菜单(输入 "/" 时浮现在输入框上方)。
// 复用个人工作区 slash 体系:SlashCommand 类型与 matchSlashCommands 匹配来自 ComposerShell,
// 样式沿用 .pw-slash-* 既有规则。与 ComposerShell 的差异:写作侧选中即把 `/skill:name ` 插回
// textarea(无 skill pill 形态),且只有 skill 项(无 /clear 等内建命令)。
import type { ReactElement } from "react";
import { Icon } from "@cortex-work/ui/icons";
import type { SlashCommand } from "../personal/ComposerShell";

interface Props {
  // 已按输入过滤排序的命中项(matchSlashCommands 产出)。
  matches: SlashCommand[];
  // 当前键盘高亮索引(父组件持有,↑/↓ 驱动)。
  activeIndex: number;
  onHover: (index: number) => void;
  // 选中一项(点击或 Enter/Tab):父组件负责把 cmd 插入输入框。
  onPick: (cmd: SlashCommand) => void;
}

export function WritingSlashMenu({ matches, activeIndex, onHover, onPick }: Props): ReactElement {
  return (
    <div className="pw-slash-hint pw-wa-slash" role="listbox">
      {matches.map((c, i) => {
        const active = i === Math.min(activeIndex, matches.length - 1);
        return (
          <button
            key={c.cmd}
            type="button"
            role="option"
            aria-selected={active}
            className={`pw-slash-item ${active ? "is-active" : ""}`}
            onMouseEnter={() => onHover(i)}
            // mousedown 而非 click:避免 textarea 先失焦引发菜单关闭后点击落空。
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(c);
            }}
          >
            <Icon.Sparkle size={14} className="pw-slash-icon" />
            <span className="pw-slash-name">{c.displayName ?? c.cmd}</span>
            <span className="pw-slash-desc" title={c.desc}>
              {c.desc}
            </span>
            {active ? <kbd className="pw-slash-kbd">插入</kbd> : null}
          </button>
        );
      })}
    </div>
  );
}
