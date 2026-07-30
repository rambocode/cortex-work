// StickyNoteNode.tsx — 便签(sticky note)画布节点组件。
// 便签是画布注释：彩色卡片 + Markdown 正文，可拖动/缩放/双击编辑/改色/删除，不参与连接与执行。
//
// ⚠️ 与 WorkflowNodes.tsx 同样静态 import @xyflow/react，只能经 WorkflowCanvas 动态加载链触达
//    （workflowNodeTypes 里 sticky-note → 本组件）。不可在 SSR 顶层静态引入。
// ⚠️ 尺寸由 RF 节点 style 驱动（toFlowNodes 据 config.width/height 注入），本组件填充 100%；
//    NodeResizer 缩放结束时把最终宽高回写 config（actions.updateNode）。
// ⚠️ 编辑用本地 buffer，仅在失焦/Cmd+Enter 提交，避免每次按键都触发画布回写与重渲染。

import {
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  NodeResizer,
  NodeToolbar,
  Position,
  type NodeProps,
} from "@xyflow/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "@cortex-work/ui/icons";
import type { WorkflowNode } from "@cortex-work/core";
import type { WorkflowFlowNodeData } from "./workflow-flow";
import { WorkflowNodeActionsContext } from "./WorkflowNodes";
import {
  STICKY_NOTE_COLORS,
  STICKY_MIN_WIDTH,
  STICKY_MIN_HEIGHT,
} from "./workflow-sticky";

// 便签是 WorkflowNode 中 type 为 sticky-note 的成员，narrow 后 config 即 WorkflowStickyNoteConfig。
type StickyNode = Extract<WorkflowNode, { type: "sticky-note" }>;

// 工具栏按钮：尺寸/布局走 Tailwind，颜色/hover 由未分层 .wf-node-tb 提供（与 WorkflowNodes
// 同范式，避免全局 button reset 抹平 hover 工具类）；nodrag/nopan 防触发画布平移/拖动。
const TB_BTN =
  "nodrag nopan flex h-[30px] w-[30px] items-center justify-center rounded-lg transition wf-node-tb";

// Markdown 子元素轻量排版（无 prose 插件，仅按便签场景给标题/加粗/链接/列表最小样式）。
const MD_CLASS =
  "h-full overflow-auto break-words text-[12.5px] leading-snug text-ds-ink " +
  "[&_h1]:mb-1 [&_h1]:text-[15px] [&_h1]:font-semibold " +
  "[&_h2]:mb-1 [&_h2]:text-[14px] [&_h2]:font-semibold " +
  "[&_p]:my-1 [&_strong]:font-semibold [&_a]:underline " +
  "[&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4 " +
  "[&_code]:rounded [&_code]:bg-black/5 [&_code]:px-1 [&_code]:text-[11.5px]";

// 链接渲染：阻止默认导航（Electron 下原生导航会劫持整窗），便签里链接仅作视觉标注。
const MD_COMPONENTS = {
  a: ({
    href,
    children,
  }: {
    href?: string;
    children?: ReactNode;
  }) => (
    <a
      href={href}
      title={href}
      className="text-ds-ink underline"
      onClick={(e) => e.preventDefault()}
    >
      {children}
    </a>
  ),
};

export function StickyNoteNode({ id, data, selected }: NodeProps): ReactElement {
  const actions = useContext(WorkflowNodeActionsContext);
  const node = (data as WorkflowFlowNodeData).node as StickyNode;
  const { content, color } = node.config;

  // 编辑态本地缓冲（提交前不回写画布）。
  const [editing, setEditing] = useState(false);
  const [buffer, setBuffer] = useState(content);
  const [colorOpen, setColorOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 进入编辑时同步缓冲并聚焦、全选。
  useEffect(() => {
    if (editing) {
      setBuffer(content);
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.select();
      }
    }
    // content 变化（外部改）不应打断正在进行的编辑，故仅依赖 editing。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  function commit() {
    setEditing(false);
    if (buffer !== content) {
      actions.updateNode({
        ...node,
        config: { ...node.config, content: buffer },
      });
    }
  }

  function changeColor(next: string) {
    setColorOpen(false);
    if (next !== color) {
      actions.updateNode({ ...node, config: { ...node.config, color: next } });
    }
  }

  return (
    <div
      className={`relative flex h-full w-full flex-col border p-3 shadow-sm transition ${
        selected ? "border-accent ring-2 ring-accent/25" : "border-black/10"
      }`}
      style={{ background: color }}
      onDoubleClick={() => setEditing(true)}
    >
      {/* 缩放手柄（仅选中时）；结束时把最终宽高回写 config（见文件头注释）。 */}
      <NodeResizer
        isVisible={selected}
        minWidth={STICKY_MIN_WIDTH}
        minHeight={STICKY_MIN_HEIGHT}
        lineClassName="!border-accent/40"
        handleClassName="!h-2 !w-2 !rounded-sm !border-accent !bg-white"
        onResizeEnd={(_e, params) => {
          actions.updateNode({
            ...node,
            config: {
              ...node.config,
              width: Math.round(params.width),
              height: Math.round(params.height),
            },
          });
        }}
      />

      {/* 选中工具栏：改色 / 删除（对齐设计稿 hover 工具条）。 */}
      <NodeToolbar isVisible={selected} position={Position.Top} offset={8}>
        <div className="relative flex items-center gap-1 rounded-lg border border-ds-border bg-ds-card p-1.5 shadow-md">
          <button
            type="button"
            className={TB_BTN}
            title="更改颜色"
            aria-label="更改颜色"
            onClick={() => setColorOpen((v) => !v)}
          >
            <Icon.Palette size={14} sw={1.9} />
          </button>
          <button
            type="button"
            className={`${TB_BTN} danger`}
            title="删除便签"
            aria-label="删除便签"
            onClick={() => actions.deleteNode(id)}
          >
            <Icon.Trash size={14} sw={1.9} />
          </button>

          {/* 调色板弹层 */}
          {colorOpen ? (
            <div className="absolute left-0 top-full mt-1 flex gap-1 rounded-lg border border-ds-border bg-ds-card p-1.5 shadow-md">
              {STICKY_NOTE_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  title={c.label}
                  aria-label={`颜色 ${c.label}`}
                  onClick={() => changeColor(c.value)}
                  className={`h-5 w-5 rounded-full border transition hover:scale-110 ${
                    c.value === color ? "border-ds-ink" : "border-black/10"
                  }`}
                  style={{ background: c.value }}
                />
              ))}
            </div>
          ) : null}
        </div>
      </NodeToolbar>

      {/* 正文：编辑态 textarea / 展示态 Markdown */}
      {editing ? (
        <textarea
          ref={textareaRef}
          className="nodrag nopan h-full w-full flex-1 resize-none bg-transparent text-[12.5px] leading-snug text-ds-ink outline-none"
          value={buffer}
          onChange={(e) => setBuffer(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false); // 放弃改动
            }
          }}
        />
      ) : (
        <div className={MD_CLASS}>
          <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
            {content}
          </Markdown>
        </div>
      )}
    </div>
  );
}
