// 写作助手空态(对齐 Kun WriteAssistantPanel 空态形态):
//   顶部「写作助手待命中」待命卡,底部三张固定快捷卡(总结当前文档 / 拟一个大纲 / 润色选中文本),
//   卡片带彩色圆角图标(sky/emerald/amber,逐一对齐 Kun 的 FileText/ListTodo/MessageSquareQuote)。
// 三卡从 resolveWritingQuickActions 的内置项取 prompt(尊重用户在设置里的自定义覆盖),被禁用的
// 内置项不渲染对应卡;其余快捷指令不进空态(它们是选区操作,由面板的选区 chip 条承载)。
import type { ReactElement } from "react";
import { FileText, ListTodo, MessageSquareQuote, Sparkles } from "lucide-react";
import type { ResolvedWritingQuickAction } from "@cortex-work/core/writing/quick-actions";

// 空态固定三卡的静态描述:id 对应内置快捷指令;标题/副标题为 Kun 空态专用文案
// (polish 内置 label 是「润色」,空态卡按 Kun 显示「润色选中文本」,选区 chip 仍显示「润色」)。
const EMPTY_CARDS: {
  id: string;
  title: string;
  sub: string;
  tone: "sky" | "emerald" | "amber";
  icon: ReactElement;
}[] = [
  {
    id: "summarize",
    title: "总结当前文档",
    sub: "提炼结构、主题和缺口",
    tone: "sky",
    icon: <FileText size={16} strokeWidth={1.9} />,
  },
  {
    id: "outline",
    title: "拟一个大纲",
    sub: "整理标题和段落推进",
    tone: "emerald",
    icon: <ListTodo size={16} strokeWidth={1.9} />,
  },
  {
    id: "polish",
    title: "润色选中文本",
    sub: "先选中文本会自动带引用",
    tone: "amber",
    icon: <MessageSquareQuote size={16} strokeWidth={1.9} />,
  },
];

interface Props {
  // 已解析的快捷指令全集(禁用项已滤掉);空态只挑 EMPTY_CARDS 对应的内置项渲染。
  actions: ResolvedWritingQuickAction[];
  // 派发一条快捷指令(与面板 runQuickAction 同源:polish 有选区引用+填入,无选区仅填入)。
  onRun: (action: ResolvedWritingQuickAction) => void;
}

export function WritingEmptyState({ actions, onRun }: Props): ReactElement {
  const byId = new Map(actions.map((a) => [a.id, a]));
  return (
    <div className="pw-wa-empty">
      <div className="pw-wa-empty-card">
        <div className="pw-wa-empty-icon">
          <Sparkles size={20} strokeWidth={1.9} />
        </div>
        <h3 className="pw-wa-empty-title">写作助手待命中</h3>
        <p className="pw-wa-empty-sub">
          它不会再抢占写作空间。选中文本后点引用，或直接从下面选一个写作动作开始。
        </p>
      </div>
      <div className="pw-wa-cards">
        {EMPTY_CARDS.map((card) => {
          const action = byId.get(card.id);
          if (!action) return null; // 该内置项被用户禁用 → 不渲染对应卡
          return (
            <button
              key={card.id}
              type="button"
              className="pw-wa-card"
              onClick={() => onRun(action)}
            >
              <span className="pw-wa-card-ic" data-tone={card.tone}>
                {card.icon}
              </span>
              <span className="pw-wa-card-tx">
                <span className="pw-wa-card-t">{card.title}</span>
                <span className="pw-wa-card-s">{card.sub}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
