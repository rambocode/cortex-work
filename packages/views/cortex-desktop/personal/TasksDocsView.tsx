// 右栏「Tasks」视图：聚合 docs/{ideation,brainstorms,plans} 文档，按规范状态纵向分组
// （320px 窄轨，不用横向看板）+ 多维标签筛选 + origin 血缘流水线视图 + 卡片「继续」动作。
// 数据全部来自 core 的 useDocTasks（已解析/归一/打标签/串血缘）；详情复用 MarkdownView。

import { useEffect, useMemo, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  docTasksAvailable,
  nextSkillForKind,
  useContinueDoc,
  useDocTasks,
  useDocTasksWatch,
  useDesktopBridge,
  TASK_STATUS_LABEL,
  TASK_STATUS_ORDER,
} from "@cortex-work/core";
import type { DocMetaView, Tag, TagDim, TaskStatus } from "@cortex-work/core";
import { MarkdownView } from "./MarkdownView";
import { DocEditDialog } from "./DocEditDialog";
import { relTime } from "./PersonalSidebar";

const DIM_ORDER: TagDim[] = ["stage", "type", "topic", "depth"];

// 文档卡：阶段/类型标签 + 标题 + 相对时间 + 状态 pill + 继续按钮。
function DocCard({
  doc,
  onOpen,
  onContinue,
  continuing,
}: {
  doc: DocMetaView;
  onOpen: (doc: DocMetaView) => void;
  onContinue: (doc: DocMetaView) => void;
  continuing: boolean;
}) {
  const next = nextSkillForKind(doc.kind);
  const stage = doc.tags.find((t) => t.dim === "stage");
  const type = doc.tags.find((t) => t.dim === "type");
  const canContinue = doc.status !== "done";
  return (
    <div className="pw-doc-card" onClick={() => onOpen(doc)} title={doc.path}>
      <div className="pw-doc-card-tags">
        {stage ? <span className="pw-doc-tag pw-doc-tag-stage">{stage.label}</span> : null}
        {type ? <span className="pw-doc-tag pw-doc-tag-type">{type.label}</span> : null}
        <span className="spacer" />
        <span className="pw-doc-time">{doc.date || relTime(doc.mtimeMs)}</span>
      </div>
      <div className="pw-doc-card-title">{doc.title}</div>
      {/* 文件名（basename）：让用户在列表里就能区分同标题/同日期的不同文档，hover 显示仓库相对全路径。 */}
      <div className="pw-doc-card-file" title={doc.path}>
        <Icon.File size={10} />
        <span>{doc.name}</span>
      </div>
      <div className="pw-doc-card-foot">
        <span className={`pw-doc-status pw-doc-status-${doc.status}`}>
          {TASK_STATUS_LABEL[doc.status]}
          {doc.statusRaw && TASK_STATUS_LABEL[doc.status] !== doc.statusRaw ? (
            <span className="pw-doc-status-raw" title={doc.statusRaw}>
              {" "}
              ·
            </span>
          ) : null}
        </span>
        <span className="spacer" />
        <button
          className="pw-tl-gen"
          disabled={!canContinue || continuing}
          title={canContinue ? next.label : "已完成"}
          onClick={(e) => {
            e.stopPropagation();
            onContinue(doc);
          }}
        >
          {continuing ? "启动中…" : next.label}
        </button>
      </div>
    </div>
  );
}

// 详情态：读 path 渲染 Markdown（只读），可用系统编辑器打开 / 二次编辑发送到 Agent。
function DocDetail({ doc, onBack, onToast }: { doc: DocMetaView; onBack: () => void; onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [selection, setSelection] = useState("");

  // 在 md 区选中一段文本（鼠标释放）即直接打开二次编辑面板；空选区不触发。
  const onSelectText = () => {
    const text = window.getSelection()?.toString() ?? "";
    if (!text.trim()) return;
    setSelection(text);
    setEditOpen(true);
  };

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError(null);
    bridge
      ?.readFile(doc.path)
      .then((res) => {
        if (!cancelled) setContent(res.content);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, doc.path]);

  return (
    <div className="pw-todo-detail">
      <div className="pw-todo-detail-h">
        <button className="pw-icon-btn" title="返回列表" onClick={onBack}>
          <Icon.Back size={14} />
        </button>
        <span className="pw-doc-detail-title">{doc.title}</span>
        <div className="spacer" />
        {bridge?.openPath ? (
          <button className="pw-icon-btn" title="用系统编辑器打开" onClick={() => void bridge.openPath?.(doc.path)}>
            <Icon.Share size={13} />
          </button>
        ) : null}
      </div>
      {/* 文件详细路径（仓库相对）：详情态下完整展示，便于定位/复制源文档位置。 */}
      <div className="pw-doc-detail-path" title={doc.path}>{doc.path}</div>
      {error ? (
        <div className="pw-editor-error">{error}</div>
      ) : content === null ? (
        <div className="pw-editor-loading">加载中…</div>
      ) : (
        // 选中一段文本（鼠标释放）即直接打开二次编辑面板。
        <div className="pw-todo-md" onMouseUp={onSelectText}>
          <MarkdownView content={content} />
        </div>
      )}
      {editOpen ? (
        <DocEditDialog
          path={doc.path}
          selection={selection}
          onClose={() => setEditOpen(false)}
          onToast={onToast}
        />
      ) : null}
    </div>
  );
}

export function TasksDocsView({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const { data } = useDocTasks();
  useDocTasksWatch();
  const continueDoc = useContinueDoc();

  const [selected, setSelected] = useState<DocMetaView | null>(null);
  const [filters, setFilters] = useState<Set<string>>(new Set()); // "dim:value"
  const [collapsed, setCollapsed] = useState<Set<TaskStatus>>(new Set(["done"]));
  const [lineageMode, setLineageMode] = useState(false);
  const [continuingPath, setContinuingPath] = useState<string | null>(null);

  const docs = useMemo(() => data?.docs ?? [], [data]);

  // 全部可选标签（按维度归并去重）。
  const chips = useMemo(() => {
    const seen = new Map<string, Tag>();
    for (const d of docs) for (const t of d.tags) seen.set(`${t.dim}:${t.value}`, t);
    return DIM_ORDER.flatMap((dim) =>
      [...seen.entries()].filter(([k]) => k.startsWith(`${dim}:`)).map(([k, t]) => ({ key: k, tag: t })),
    );
  }, [docs]);

  // 筛选：同维多选 OR，跨维 AND。
  const passes = useMemo(() => {
    const byDim = new Map<TagDim, Set<string>>();
    for (const key of filters) {
      const [dim, value] = key.split(":") as [TagDim, string];
      const set = byDim.get(dim) ?? new Set<string>();
      set.add(value);
      byDim.set(dim, set);
    }
    return (doc: DocMetaView) => {
      for (const [dim, vals] of byDim) {
        if (!doc.tags.some((t) => t.dim === dim && vals.has(t.value))) return false;
      }
      return true;
    };
  }, [filters]);

  const toggleFilter = (key: string) =>
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const onContinue = async (doc: DocMetaView) => {
    setContinuingPath(doc.path);
    try {
      await continueDoc(doc, onToast);
    } finally {
      setContinuingPath(null);
    }
  };

  if (!docTasksAvailable(bridge)) {
    return (
      <div className="pw-rp-view pw-todos">
        <div className="pw-empty-hint">当前环境不支持文档面板（缺少桌面能力）。</div>
      </div>
    );
  }
  // 详情态：根节点带 .pw-todos.is-detail —— 复用既有 CSS 档位（右栏向左展宽 + 左缘拖拽条
  // 出现 + 详情高度自适应填满），返回列表后移除该类自动还原 320px。
  if (selected) {
    return (
      <div className="pw-rp-view pw-todos is-detail">
        <DocDetail doc={selected} onBack={() => setSelected(null)} onToast={onToast} />
      </div>
    );
  }

  const filtered = docs.filter(passes);

  // 分组视图（默认）：按规范状态分组，组内按 mtime 降序。
  const groups = TASK_STATUS_ORDER.map((status) => ({
    status,
    items: filtered.filter((d) => d.status === status).sort((a, b) => b.mtimeMs - a.mtimeMs),
  })).filter((g) => g.items.length > 0);

  // 血缘视图：流水线（任一节点通过筛选即显示）+ 孤儿。
  const pipelines = (data?.pipelines ?? []).filter((chain) => chain.some(passes));
  const orphans = (data?.orphans ?? []).filter(passes);

  return (
    <div className="pw-rp-view pw-todos pw-doc-view">
      <div className="pw-doc-toolbar">
        <button
          className={`pw-doc-mode ${lineageMode ? "is-on" : ""}`}
          title="按 origin 血缘聚合为流水线"
          onClick={() => setLineageMode((v) => !v)}
        >
          <Icon.GitBranch size={12} /> 血缘
        </button>
        <div className="pw-doc-chips">
          {chips.map(({ key, tag }) => (
            <button
              key={key}
              className={`pw-doc-chip pw-doc-chip-${tag.dim} ${filters.has(key) ? "is-on" : ""}`}
              onClick={() => toggleFilter(key)}
            >
              {tag.label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="pw-empty-hint">没有匹配的文档。深化闪记或运行 ce-plan 会在这里出现。</div>
      ) : lineageMode ? (
        <div className="pw-doc-list">
          {pipelines.map((chain, i) => (
            <div className="pw-doc-pipeline" key={`pl-${i}`}>
              <div className="pw-doc-pipeline-h">
                {chain.map((d, j) => (
                  <span key={d.path}>
                    <span className={`pw-doc-pip-node pw-doc-status-${d.status}`}>{d.tags[0]?.label}</span>
                    {j < chain.length - 1 ? <span className="pw-doc-pip-arrow">→</span> : null}
                  </span>
                ))}
              </div>
              {chain.map((d) => (
                <DocCard key={d.path} doc={d} onOpen={setSelected} onContinue={onContinue} continuing={continuingPath === d.path} />
              ))}
            </div>
          ))}
          {orphans.length > 0 ? (
            <div className="pw-doc-group-h">独立文档</div>
          ) : null}
          {orphans.map((d) => (
            <DocCard key={d.path} doc={d} onOpen={setSelected} onContinue={onContinue} continuing={continuingPath === d.path} />
          ))}
        </div>
      ) : (
        <div className="pw-doc-list">
          {groups.map((g) => {
            const isCollapsed = collapsed.has(g.status);
            return (
              <div className="pw-doc-group" key={g.status}>
                <button
                  className="pw-doc-group-h"
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(g.status)) next.delete(g.status);
                      else next.add(g.status);
                      return next;
                    })
                  }
                >
                  <Icon.ChevronRight size={12} className={isCollapsed ? "" : "pw-rot90"} />
                  {TASK_STATUS_LABEL[g.status]} ({g.items.length})
                </button>
                {isCollapsed
                  ? null
                  : g.items.map((d) => (
                      <DocCard
                        key={d.path}
                        doc={d}
                        onOpen={setSelected}
                        onContinue={onContinue}
                        continuing={continuingPath === d.path}
                      />
                    ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
