// 右栏「Tasks」视图：聚合 docs/{ideation,brainstorms,plans} 文档，按规范状态纵向分组
// （320px 窄轨，不用横向看板）+ 多维标签筛选 + origin 血缘流水线视图 + 卡片「继续」动作。
// 数据全部来自 core 的 useDocTasks（已解析/归一/打标签/串血缘）；详情复用 MarkdownView。

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@cortex-work/ui/icons";
import {
  docTasksAvailable,
  nextSkillForKind,
  useContinueDoc,
  useDocTasks,
  useDocTasksWatch,
  useDesktopBridge,
  TASK_STATUS_ORDER,
} from "@cortex-work/core";
import type { DocMetaView, Tag, TagDim, TaskStatus } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { MarkdownView } from "./MarkdownView";
import { MonacoViewer } from "./MonacoViewer";
import { DocEditDialog } from "./DocEditDialog";
import { relTime } from "./PersonalSidebar";

const DIM_ORDER: TagDim[] = ["stage", "type", "topic", "depth"];

// 下一步 skill → i18n key（core 的 nextSkillForKind.label 仍供 useContinueDoc 拼 prompt 用,
// UI 文案走 i18n）。
const NEXT_KEY: Record<string, "brainstorm" | "plan" | "work"> = {
  "ce-brainstorm": "brainstorm",
  "ce-plan": "plan",
  "ce-work": "work",
};

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
  const { t } = useTranslation("files");
  const next = nextSkillForKind(doc.kind);
  const nextLabel = t(`tasks.next.${NEXT_KEY[next.name] ?? "work"}`);
  const statusLabel = t(`tasks.status.${doc.status}`);
  const stage = doc.tags.find((tag) => tag.dim === "stage");
  const type = doc.tags.find((tag) => tag.dim === "type");
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
          {statusLabel}
          {doc.statusRaw && statusLabel !== doc.statusRaw ? (
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
          title={canContinue ? nextLabel : t("tasks.done")}
          onClick={(e) => {
            e.stopPropagation();
            onContinue(doc);
          }}
        >
          {continuing ? t("tasks.continuing") : nextLabel}
        </button>
      </div>
    </div>
  );
}

// 详情态：读 path 渲染 Markdown（只读），可用系统编辑器打开 / 二次编辑发送到 Agent。
function DocDetail({ doc, onBack, onToast }: { doc: DocMetaView; onBack: () => void; onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const { t } = useTranslation("files");
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [selection, setSelection] = useState("");
  // 在线编辑（复用 FilesView 的 Monaco 编辑/保存范式）。
  const [editMode, setEditMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const draftRef = useRef("");

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
    setEditMode(false);
    setDirty(false);
    bridge
      ?.readFile(doc.path)
      .then((res) => {
        if (!cancelled) {
          setContent(res.content);
          draftRef.current = res.content;
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, doc.path]);

  // 保存:写回源文档（bridge.writeFile），成功后同步 content + 清 dirty。
  // 不弹「已保存」提示（按需求去掉成功 toast）;失败仍 toast。返回是否成功供「保存并退出」判断。
  const save = async (): Promise<boolean> => {
    if (!bridge || !dirty) return true;
    try {
      await bridge.writeFile(doc.path, draftRef.current);
      setContent(draftRef.current);
      setDirty(false);
      return true;
    } catch (err) {
      onToast(t("saveFailed", { error: err instanceof Error ? err.message : String(err) }));
      return false;
    }
  };
  // 保存并退出:仅在保存成功时退出编辑（失败留在编辑态,避免丢稿）。
  const saveAndExit = async () => {
    if (await save()) setEditMode(false);
  };
  // 取消:放弃改动并退出（草稿回退到当前内容）。
  const cancelEdit = () => {
    draftRef.current = content ?? "";
    setDirty(false);
    setEditMode(false);
  };

  return (
    <div className="pw-todo-detail">
      <div className="pw-todo-detail-h">
        <button className="pw-icon-btn" title={t("tasks.back")} onClick={onBack}>
          <Icon.Back size={14} />
        </button>
        <span className="pw-doc-detail-title">{doc.title}</span>
        {dirty ? <span className="pw-dirty">●</span> : null}
        <div className="spacer" />
        {editMode ? (
          <>
            <button className="pw-ftb-btn" title={t("toolbar.cancelTitle")} onClick={cancelEdit}>
              {t("toolbar.cancel")}
            </button>
            <button className="pw-ftb-btn is-primary" title={t("toolbar.saveTitle")} onClick={() => void saveAndExit()}>
              <Icon.Check size={12} />
              {t("toolbar.save")}
            </button>
          </>
        ) : (
          <>
            {content !== null ? (
              <button
                className="pw-ftb-btn"
                title={t("toolbar.editTitle")}
                onClick={() => {
                  draftRef.current = content;
                  setEditMode(true);
                }}
              >
                <Icon.Edit size={12} />
                {t("toolbar.edit")}
              </button>
            ) : null}
            {bridge?.openPath ? (
              <button className="pw-icon-btn" title={t("tasks.openInSystemEditor")} onClick={() => void bridge.openPath?.(doc.path)}>
                <Icon.Share size={13} />
              </button>
            ) : null}
          </>
        )}
      </div>
      {/* 文件详细路径（仓库相对）：详情态下完整展示，便于定位/复制源文档位置。 */}
      <div className="pw-doc-detail-path" title={doc.path}>{doc.path}</div>
      {error ? (
        <div className="pw-editor-error">{error}</div>
      ) : content === null ? (
        <div className="pw-editor-loading">{t("tasks.loading")}</div>
      ) : editMode ? (
        // 在线编辑:Monaco markdown 源码编辑;⌘S 保存。
        <div className="pw-mona-wrap">
          <MonacoViewer
            key={doc.path}
            value={content}
            language="markdown"
            wordWrap
            readOnly={false}
            onChange={(v) => {
              draftRef.current = v;
              setDirty(v !== content);
            }}
            onSave={() => void save()}
          />
        </div>
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
  const { t } = useTranslation("files");
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
    for (const d of docs) for (const tag of d.tags) seen.set(`${tag.dim}:${tag.value}`, tag);
    return DIM_ORDER.flatMap((dim) =>
      [...seen.entries()].filter(([k]) => k.startsWith(`${dim}:`)).map(([k, tag]) => ({ key: k, tag })),
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
        if (!doc.tags.some((tag) => tag.dim === dim && vals.has(tag.value))) return false;
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
        <div className="pw-empty-hint">{t("tasks.unavailable")}</div>
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
          title={t("tasks.lineageTitle")}
          onClick={() => setLineageMode((v) => !v)}
        >
          <Icon.GitBranch size={12} /> {t("tasks.lineage")}
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
        <div className="pw-empty-hint">{t("tasks.empty")}</div>
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
            <div className="pw-doc-group-h">{t("tasks.orphans")}</div>
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
                  {t(`tasks.status.${g.status}`)} ({g.items.length})
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
