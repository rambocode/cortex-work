// 富文本选区浮动工具条(对齐 Kun 选区工具条的最小集):有文本选区时浮现在选区上方,
// 提供行内格式(加粗/斜体/删除线/行内代码)与块类型(H1/H2/H3/引用/无序/有序/代码块)切换。
// 纯展示:editor 由 WritingRichEditor 注入(类型 import type,调用其方法无需 tiptap 运行时 import,不影响 web 隔离)。
import { type ReactElement, type ReactNode } from "react";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Quote,
  Sparkles,
  Strikethrough,
} from "lucide-react";
import type { Editor } from "@tiptap/core";

interface Props {
  editor: Editor;
  // 选区上方锚点(视口坐标),工具条以此定位(fixed)。
  top: number;
  left: number;
  // 选区变化后强制重算 isActive 高亮的信号(WritingRichEditor 每次选区更新自增)。
  revision: number;
  // 信息图生成入口(U7):仅当 media-gen 已配置且环境支持时由上层注入,否则不渲染该按钮。
  // 点击 → 上层用当前选区文本生成信息图并在光标处插入图片。生成中由上层 disabled 兜底(此处只发起)。
  onInfographic?: () => void;
  infographicBusy?: boolean;
}

// 单个工具按钮:onMouseDown 阻止默认,避免点击时编辑器失焦/选区塌陷。
function TB({
  active,
  title,
  onRun,
  children,
}: {
  active: boolean;
  title: string;
  onRun: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      className={`pw-writing-rich-tb-btn${active ? " is-active" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onRun}
    >
      {children}
    </button>
  );
}

export function WritingRichToolbar({
  editor,
  top,
  left,
  revision,
  onInfographic,
  infographicBusy,
}: Props): ReactElement {
  // revision 仅用于让 React 在选区变化时重渲染(读取最新 isActive);本体不直接用其值。
  void revision;
  const chain = () => editor.chain().focus();
  return (
    <div className="pw-writing-rich-tb" style={{ top, left }} role="toolbar" aria-label="富文本格式">
      <TB active={editor.isActive("bold")} title="加粗" onRun={() => chain().toggleBold().run()}>
        <Bold size={15} strokeWidth={2} />
      </TB>
      <TB active={editor.isActive("italic")} title="斜体" onRun={() => chain().toggleItalic().run()}>
        <Italic size={15} strokeWidth={2} />
      </TB>
      <TB active={editor.isActive("strike")} title="删除线" onRun={() => chain().toggleStrike().run()}>
        <Strikethrough size={15} strokeWidth={2} />
      </TB>
      <TB active={editor.isActive("code")} title="行内代码" onRun={() => chain().toggleCode().run()}>
        <Code size={15} strokeWidth={2} />
      </TB>
      <span className="pw-writing-rich-tb-sep" aria-hidden />
      <TB
        active={editor.isActive("heading", { level: 1 })}
        title="一级标题"
        onRun={() => chain().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 size={15} strokeWidth={2} />
      </TB>
      <TB
        active={editor.isActive("heading", { level: 2 })}
        title="二级标题"
        onRun={() => chain().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 size={15} strokeWidth={2} />
      </TB>
      <TB
        active={editor.isActive("heading", { level: 3 })}
        title="三级标题"
        onRun={() => chain().toggleHeading({ level: 3 }).run()}
      >
        <Heading3 size={15} strokeWidth={2} />
      </TB>
      <span className="pw-writing-rich-tb-sep" aria-hidden />
      <TB active={editor.isActive("bulletList")} title="无序列表" onRun={() => chain().toggleBulletList().run()}>
        <List size={15} strokeWidth={2} />
      </TB>
      <TB active={editor.isActive("orderedList")} title="有序列表" onRun={() => chain().toggleOrderedList().run()}>
        <ListOrdered size={15} strokeWidth={2} />
      </TB>
      <TB active={editor.isActive("blockquote")} title="引用" onRun={() => chain().toggleBlockquote().run()}>
        <Quote size={15} strokeWidth={2} />
      </TB>
      <TB active={editor.isActive("codeBlock")} title="代码块" onRun={() => chain().toggleCodeBlock().run()}>
        <Code size={15} strokeWidth={2} />
      </TB>
      {/* 信息图生成(U7):仅当上层注入 onInfographic(media-gen 已配置)时出现;生成中禁用防重复发起。*/}
      {onInfographic ? (
        <>
          <span className="pw-writing-rich-tb-sep" aria-hidden />
          <button
            type="button"
            className="pw-writing-rich-tb-btn"
            title={infographicBusy ? "信息图生成中…" : "用选中文字生成信息图"}
            aria-label="生成信息图"
            disabled={infographicBusy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onInfographic}
          >
            <Sparkles size={15} strokeWidth={2} />
          </button>
        </>
      ) : null}
    </div>
  );
}
