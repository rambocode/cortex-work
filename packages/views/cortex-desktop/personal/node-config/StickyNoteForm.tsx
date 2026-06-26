// StickyNoteForm.tsx — 便签节点的右侧配置面板表单（兜底编辑）。
// 画布内双击编辑为主，本表单兜底：选中便签即可在右面板改内容/颜色/尺寸，
// 与画布交互共用同一 config，经 onNodeChange 回写。

import type { WorkflowNode } from "@cortex-work/core";
import { INPUT_CLS, FIELD_LABEL_CLS } from "./TriggerNodeForm";
import {
  STICKY_NOTE_COLORS,
  STICKY_MIN_WIDTH,
  STICKY_MIN_HEIGHT,
} from "../workflow-sticky";

type StickyNode = Extract<WorkflowNode, { type: "sticky-note" }>;

export function StickyNoteForm({
  node,
  onChange,
}: {
  node: StickyNode;
  onChange: (updated: WorkflowNode) => void;
}) {
  const cfg = node.config;
  function update(patch: Partial<typeof cfg>) {
    onChange({ ...node, config: { ...cfg, ...patch } });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 内容（Markdown） */}
      <div className="flex flex-col gap-1">
        <label className={FIELD_LABEL_CLS}>内容（Markdown）</label>
        <textarea
          className={`${INPUT_CLS} min-h-[120px] resize-y font-mono text-[12px]`}
          value={cfg.content}
          placeholder={"## 标题\n\n**加粗** 文本"}
          onChange={(e) => update({ content: e.target.value })}
        />
      </div>

      {/* 颜色 */}
      <div className="flex flex-col gap-1.5">
        <label className={FIELD_LABEL_CLS}>颜色</label>
        <div className="flex flex-wrap gap-1.5">
          {STICKY_NOTE_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-label={`颜色 ${c.label}`}
              title={c.label}
              onClick={() => update({ color: c.value })}
              className={`h-6 w-6 rounded-full border transition hover:scale-110 ${
                c.value === cfg.color
                  ? "border-ds-ink ring-2 ring-accent/30"
                  : "border-black/10"
              }`}
              style={{ background: c.value }}
            />
          ))}
        </div>
      </div>

      {/* 尺寸 */}
      <div className="flex gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <label className={FIELD_LABEL_CLS}>宽度（px）</label>
          <input
            type="number"
            className={INPUT_CLS}
            value={cfg.width}
            min={STICKY_MIN_WIDTH}
            max={4000}
            onChange={(e) => update({ width: Number(e.target.value) })}
          />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <label className={FIELD_LABEL_CLS}>高度（px）</label>
          <input
            type="number"
            className={INPUT_CLS}
            value={cfg.height}
            min={STICKY_MIN_HEIGHT}
            max={4000}
            onChange={(e) => update({ height: Number(e.target.value) })}
          />
        </div>
      </div>
    </div>
  );
}
