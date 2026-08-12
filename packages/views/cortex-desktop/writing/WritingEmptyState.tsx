// 写作助手空态(按「写作界面 Redesign」设计稿):
//   一句能力说明 + 「快捷动作」分组标题 + 三行快捷动作(总结当前文档 / 拟一个大纲 / 润色选中文本)。
//   每行是「彩色圆角图标 + 主标题 + 副标题」的扁平行(hover 整行浅底),不再是描边卡片——
//   右栏只有 ~360px,卡片描边叠在窄栏里过重,行式更接近菜单、也省纵向空间。
// 三行从 resolveWritingQuickActions 的内置项取 prompt(尊重用户在设置里的自定义覆盖),被禁用的
// 内置项不渲染对应行;其余快捷指令不进空态(它们是选区操作,由面板的选区 chip 条承载)。
import type { ReactElement } from "react";
import { FileText, ListTodo, MessageSquareQuote } from "lucide-react";
import type { ResolvedWritingQuickAction } from "@cortex-work/core/writing/quick-actions";

// 空态固定三行的静态描述:id 对应内置快捷指令;标题/副标题为空态专用文案
// (polish 内置 label 是「润色」,空态行按设计稿显示「润色选中文本」,选区 chip 仍显示「润色」)。
const EMPTY_ACTIONS: {
  id: string;
  title: string;
  sub: string;
  tone: "accent" | "emerald" | "amber";
  icon: ReactElement;
}[] = [
  {
    id: "summarize",
    title: "总结当前文档",
    sub: "提炼结构、主题和缺口",
    tone: "accent",
    icon: <FileText size={15} strokeWidth={1.9} />,
  },
  {
    id: "outline",
    title: "拟一个大纲",
    sub: "整理标题和段落推进",
    tone: "emerald",
    icon: <ListTodo size={15} strokeWidth={1.9} />,
  },
  {
    id: "polish",
    title: "润色选中文本",
    sub: "先选中文本会自动带引用",
    tone: "amber",
    icon: <MessageSquareQuote size={15} strokeWidth={1.9} />,
  },
];

interface Props {
  // 已解析的快捷指令全集(禁用项已滤掉);空态只挑 EMPTY_ACTIONS 对应的内置项渲染。
  actions: ResolvedWritingQuickAction[];
  // 派发一条快捷指令(与面板 runQuickAction 同源:polish 有选区引用+填入,无选区仅填入)。
  onRun: (action: ResolvedWritingQuickAction) => void;
}

export function WritingEmptyState({ actions, onRun }: Props): ReactElement {
  const byId = new Map(actions.map((a) => [a.id, a]));
  return (
    <div className="pw-wa-empty">
      <p className="pw-wa-empty-lead">我可以基于当前文档帮你写作。选中正文文本后可直接引用。</p>
      <div className="pw-wa-empty-label">快捷动作</div>
      <div className="pw-wa-acts">
        {EMPTY_ACTIONS.map((item) => {
          const action = byId.get(item.id);
          if (!action) return null; // 该内置项被用户禁用 → 不渲染对应行
          return (
            <button key={item.id} type="button" className="pw-wa-act" onClick={() => onRun(action)}>
              <span className="pw-wa-act-ic" data-tone={item.tone}>
                {item.icon}
              </span>
              <span className="pw-wa-act-tx">
                <span className="pw-wa-act-t">{item.title}</span>
                <span className="pw-wa-act-s">{item.sub}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
