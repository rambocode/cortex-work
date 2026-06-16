// 右栏「文件」视图：当前项目目录的全部文件树,可切到「最近变更」
// （git status;非 git 仓库回退按 mtime 的最近修改）。
// - 目录实时刷新:主进程 fs.watch 推送（噪声过滤+去抖）,收到信号重扫。
// - 文件预览:Monaco 高亮 + 行号,默认只读,可进编辑态保存（⌘S）。
// - 选中片段可发送到终端（bracketed paste）或插入会话输入框。
// 变更文件优先显示 git diff（+/− 着色,仍走纯文本渲染）。

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useDesktopBridge, usePersonalStore } from "@cortex-work/core";
import type { ChangedFile, ContentSearchResult, GitChangesResult, PromptNode } from "@cortex-work/core";
import { FileIcon, fileIconSpec, isBinaryLike } from "./fileIcons";
import { langForName, wordWrapForName } from "./monacoLang";
import { MonacoViewer, type SelectionAnchor } from "./MonacoViewer";
import { MarkdownView } from "./MarkdownView";
import { buildContextSnippet, shellQuotePath, toTildePath, wrapBracketedPaste } from "./sendContext";
import { FileContextMenu, type FileCtxTarget } from "./FileContextMenu";

type Mode = "all" | "changes";

const isMarkdownName = (name: string) => /\.(md|markdown|mdx)$/i.test(name);

interface Preview {
  name: string;
  path?: string; // 绝对路径（删除占位等无路径场景为空）
  content: string;
  isDiff: boolean;
  truncated?: boolean;
  binary?: boolean;
}

function TreeRowIcon({ name }: { name: string }) {
  return fileIconSpec(name) ? <FileIcon name={name} size={13} /> : <Icon.File size={13} />;
}

function FileTreeNode({
  node,
  depth,
  onOpen,
  onCtx,
  forceExpand,
}: {
  node: PromptNode;
  depth: number;
  onOpen: (n: PromptNode) => void;
  onCtx: (e: ReactMouseEvent, path: string, name: string) => void;
  // 过滤激活时强制展开,让命中的深层文件可见（覆盖本地折叠态）。
  forceExpand?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(depth > 0);
  const isCollapsed = forceExpand ? false : collapsed;
  if (node.kind === "file") {
    return (
      <button
        className="pw-tree-row is-file"
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => onOpen(node)}
        onContextMenu={(e) => onCtx(e, node.path, node.name)}
        title={node.path}
      >
        <TreeRowIcon name={node.name} />
        <span className="pw-tree-name">{node.name}</span>
      </button>
    );
  }
  return (
    <>
      <button className="pw-tree-row is-dir" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => setCollapsed((v) => !v)}>
        <span className="chev" data-collapsed={isCollapsed}>
          <Icon.Chevron size={11} />
        </span>
        <Icon.Folder size={13} />
        <span className="pw-tree-name">{node.name}</span>
        <span className="count">{node.children?.length ?? 0}</span>
      </button>
      {!isCollapsed
        ? node.children?.map((c) => (
            <FileTreeNode key={c.path} node={c} depth={depth + 1} onOpen={onOpen} onCtx={onCtx} forceExpand={forceExpand} />
          ))
        : null}
    </>
  );
}

// 文件名过滤:文件按 name 子串匹配;目录保留任意匹配后代,或目录名自身匹配则整目录保留。
// 无匹配返回 null。q 已小写。
function filterTree(node: PromptNode, q: string): PromptNode | null {
  if (node.kind === "file") {
    return node.name.toLowerCase().includes(q) ? node : null;
  }
  if (node.name.toLowerCase().includes(q)) return node; // 目录名命中:整目录保留
  const kids = (node.children ?? []).map((c) => filterTree(c, q)).filter((c): c is PromptNode => c !== null);
  return kids.length > 0 ? { ...node, children: kids } : null;
}

function DiffText({ content }: { content: string }) {
  return (
    <pre className="pw-file-pre">
      {content.split("\n").map((line, i) => {
        const cls = line.startsWith("+") && !line.startsWith("+++")
          ? "diff-add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "diff-del"
            : line.startsWith("@@")
              ? "diff-hunk"
              : "";
        return (
          <span key={i} className={cls}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

const STATUS_LABEL: Record<string, string> = { "??": "新增", A: "新增", M: "修改", D: "删除", R: "重命名" };

export function FilesView({ onToast }: { onToast: (text: string) => void }) {
  const bridge = useDesktopBridge();
  const projects = usePersonalStore((s) => s.projects);
  const activeProjectId = usePersonalStore((s) => s.activeProjectId);
  const project = projects.find((p) => p.id === activeProjectId);

  const [mode, setMode] = useState<Mode>("all");
  const [tree, setTree] = useState<PromptNode | null>(null);
  const [changes, setChanges] = useState<GitChangesResult | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState("");
  const [selAnchor, setSelAnchor] = useState<SelectionAnchor | null>(null);
  const [ctxMenu, setCtxMenu] = useState<FileCtxTarget | null>(null);
  const draftRef = useRef("");

  // 搜索框:默认按文件名过滤;? 前缀切到内容搜索（grep）。
  const [query, setQuery] = useState("");
  const [contentResult, setContentResult] = useState<ContentSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const trimmedQuery = query.trim();
  const isContentMode = trimmedQuery.startsWith("?");
  const contentKeyword = isContentMode ? trimmedQuery.slice(1).trim() : "";
  const nameFilter = isContentMode ? "" : trimmedQuery.toLowerCase();

  const refresh = useCallback(async () => {
    if (!bridge || !project) return;
    try {
      if (mode === "all") setTree(await bridge.scanDirTree(project.path));
      else setChanges(await bridge.gitChanges(project.path));
    } catch (err) {
      onToast(`加载失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [bridge, project, mode, onToast]);

  useEffect(() => {
    setPreview(null);
    void refresh();
  }, [refresh]);

  // 切换模式 / 项目:清空搜索态,避免残留过滤或上个项目的搜索结果。
  useEffect(() => {
    setQuery("");
    setContentResult(null);
  }, [mode, project?.id]);

  // 内容搜索（? 前缀）:debounce 250ms 调 bridge.searchContent;关键词为空或非内容模式则清空。
  useEffect(() => {
    if (mode !== "all" || !isContentMode || !contentKeyword || !bridge?.searchContent || !project) {
      setContentResult(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void bridge
        .searchContent!(project.path, contentKeyword)
        .then((res) => {
          if (!cancelled) setContentResult(res);
        })
        .catch(() => {
          if (!cancelled) setContentResult({ files: [], truncated: false });
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bridge, project, mode, isContentMode, contentKeyword]);

  // 目录实时刷新:主进程已做噪声过滤 + 250ms 去抖,这里收到信号直接重扫。
  useEffect(() => {
    if (!bridge?.watchDir || !project || mode !== "all") return;
    const watchId = project.id;
    void bridge.watchDir(watchId, project.path).catch(() => {
      /* 监听失败（权限等）:保留手动刷新 */
    });
    const off = bridge.onDirChanged?.((id) => {
      if (id === watchId) void refresh();
    });
    return () => {
      off?.();
      bridge.unwatchDir?.(watchId);
    };
  }, [bridge, project, mode, refresh]);

  // GitBar「查看 diff」:消费整仓 diff 请求,打开聚合 diff 预览。消费即清,
  // 防 FilesView 重挂载时误触发;项目不匹配则不消费(等切到对应项目)。
  const gitDiffRequest = usePersonalStore((s) => s.gitDiffRequest);
  const consumeGitDiffRequest = usePersonalStore((s) => s.consumeGitDiffRequest);
  useEffect(() => {
    if (!gitDiffRequest || !bridge?.gitDiffAll || !project) return;
    if (gitDiffRequest.projectId !== project.id) return;
    consumeGitDiffRequest();
    void (async () => {
      const res = await bridge.gitDiffAll!(project.path).catch(() => null);
      if (!res) return;
      setEditMode(false);
      setDirty(false);
      setSelection("");
      setPreview({
        name: "全部变更",
        content: res.diff.trim() ? res.diff : "（没有变更）",
        isDiff: true,
        truncated: res.truncated || undefined,
      });
    })();
  }, [gitDiffRequest, bridge, project, consumeGitDiffRequest]);

  const closePreview = () => {
    setPreview(null);
    setEditMode(false);
    setDirty(false);
    setSelection("");
    setSelAnchor(null);
  };

  const openFile = async (path: string, name: string) => {
    if (!bridge) return;
    setEditMode(false);
    setDirty(false);
    setSelection("");
    if (isBinaryLike(name)) {
      setPreview({ name, path, content: "", isDiff: false, binary: true });
      return;
    }
    try {
      const { content, truncated } = await bridge.readFile(path);
      draftRef.current = content;
      setPreview({ name, path, content, isDiff: false, truncated });
    } catch (err) {
      onToast(`读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 会话消息点文件链接:消费预览请求,复用 openFile 渲染(Monaco/Markdown/二进制占位按类型)。
  // 消费即清(防重挂载误触发);项目不匹配则不消费(等切到对应项目,与 gitDiff effect 一致)。
  const filePreviewRequest = usePersonalStore((s) => s.filePreviewRequest);
  const consumeFilePreviewRequest = usePersonalStore((s) => s.consumeFilePreviewRequest);
  useEffect(() => {
    if (!filePreviewRequest || !bridge || !project) return;
    if (filePreviewRequest.projectId !== project.id) return;
    consumeFilePreviewRequest();
    void openFile(filePreviewRequest.path, filePreviewRequest.name);
    // openFile 故意不入 deps(每次渲染新建,由 request 门控执行;入 deps 会每渲染重跑)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePreviewRequest, bridge, project, consumeFilePreviewRequest]);

  const openChange = async (f: ChangedFile) => {
    if (!bridge || !project) return;
    if (f.status === "D") {
      setEditMode(false);
      setDirty(false);
      setPreview({ name: f.rel, content: "（文件已删除）", isDiff: true });
      return;
    }
    if (f.status !== "??") {
      const diff = await bridge.gitDiff(project.path, f.rel).catch(() => "");
      if (diff.trim()) {
        setEditMode(false);
        setDirty(false);
        setSelection("");
        setPreview({ name: f.rel, path: f.path, content: diff, isDiff: true });
        return;
      }
    }
    await openFile(f.path, f.rel);
  };

  const save = async () => {
    if (!bridge || !preview?.path || !dirty) return;
    try {
      await bridge.writeFile(preview.path, draftRef.current);
      setDirty(false);
      setPreview((p) => (p ? { ...p, content: draftRef.current } : p));
      onToast("已保存");
    } catch (err) {
      onToast(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const finishEdit = async () => {
    if (dirty) await save();
    setEditMode(false);
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`${label}已复制`);
    } catch {
      onToast("复制失败");
    }
  };

  const sendSelectionToTerminal = () => {
    if (!selection) return;
    const snippet = buildContextSnippet(preview?.path, selection);
    usePersonalStore.getState().sendToTerminal(wrapBracketedPaste(snippet));
    setSelAnchor(null);
    onToast("已发送到终端,补一句要求再回车");
  };

  const sendSelectionToChat = () => {
    if (!selection) return;
    usePersonalStore.getState().insertToComposer(buildContextSnippet(preview?.path, selection));
    setSelAnchor(null);
    onToast("已插入会话输入框");
  };

  // ---- 文件行右键菜单 ----
  const openCtxMenu = (e: ReactMouseEvent, path: string, name: string) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, path, name });
  };

  const ctxOpen = (t: FileCtxTarget) => {
    void bridge?.openPath?.(t.path).catch((err: unknown) => onToast(`打开失败：${err instanceof Error ? err.message : String(err)}`));
  };

  const ctxInsertChat = (t: FileCtxTarget) => {
    usePersonalStore.getState().insertToComposer("`" + toTildePath(t.path) + "` ");
    onToast("路径已插入会话输入框");
  };

  const ctxInsertTerminal = (t: FileCtxTarget) => {
    usePersonalStore.getState().sendToTerminal(wrapBracketedPaste(shellQuotePath(t.path)));
    onToast("路径已插入终端");
  };

  const ctxDelete = async (t: FileCtxTarget) => {
    if (!bridge) return;
    try {
      await bridge.deleteFile(t.path);
      if (preview?.path === t.path) closePreview();
      onToast(`已删除 ${t.name}`);
      void refresh();
    } catch (err) {
      onToast(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (!project) return <div className="pw-panel-empty">先在左侧选择一个项目</div>;

  if (preview) {
    const canEdit = !preview.isDiff && !preview.binary && !preview.truncated && !!preview.path;
    return (
      <div className="pw-rp-view is-fileopen">
        <div className="pw-editor-h pw-file-toolbar">
          <button className="pw-icon-btn" title="返回文件列表" onClick={closePreview}>
            <Icon.Back size={14} />
          </button>
          <TreeRowIcon name={preview.name} />
          <span className="pw-editor-name" title={preview.path}>
            {preview.name}
            {dirty ? <span className="pw-dirty">●</span> : null}
          </span>
          <div className="spacer" />
          {preview.isDiff ? <span className="pw-readonly">diff</span> : null}
          {preview.truncated ? <span className="pw-readonly">已截断 · 只读</span> : null}
          {editMode ? (
            <>
              <button className="pw-ftb-btn is-primary" title="保存 (⌘S)" onClick={() => void save()} disabled={!dirty}>
                <Icon.Check size={12} />
                保存
              </button>
              <button className="pw-ftb-btn" title="保存并回到预览" onClick={() => void finishEdit()}>
                完成
              </button>
            </>
          ) : (
            <>
              {canEdit ? (
                <button className="pw-ftb-btn" title="编辑文件" onClick={() => setEditMode(true)}>
                  <Icon.Edit size={12} />
                  编辑
                </button>
              ) : null}
              {!preview.binary ? (
                <button
                  className="pw-ftb-btn"
                  title="复制文件内容"
                  onClick={() => void copyText(dirty ? draftRef.current : preview.content, "内容")}
                >
                  内容
                </button>
              ) : null}
              {preview.path ? (
                <button className="pw-ftb-btn" title="复制文件路径" onClick={() => void copyText(preview.path!, "路径")}>
                  路径
                </button>
              ) : null}
              {preview.path && bridge?.openPath ? (
                <button
                  className="pw-ftb-btn"
                  title="用系统默认应用打开"
                  onClick={() => void bridge.openPath!(preview.path!).catch((e: unknown) => onToast(`打开失败：${e instanceof Error ? e.message : String(e)}`))}
                >
                  打开
                </button>
              ) : null}
              {preview.path && bridge?.revealInFolder ? (
                <button
                  className="pw-ftb-btn"
                  title="在访达中显示"
                  onClick={() => void bridge.revealInFolder!(preview.path!).catch(() => onToast("无法在访达中显示"))}
                >
                  访达
                </button>
              ) : null}
              {preview.path && !preview.isDiff && !preview.binary ? (
                <button className="pw-icon-btn" title="重新加载" onClick={() => void openFile(preview.path!, preview.name)}>
                  <Icon.Workflow size={13} />
                </button>
              ) : null}
            </>
          )}
        </div>
        {preview.isDiff ? (
          <DiffText content={preview.content} />
        ) : preview.binary ? (
          <div className="pw-panel-empty">
            <FileIcon name={preview.name} size={40} />
            <span>二进制文件,不支持文本预览</span>
          </div>
        ) : isMarkdownName(preview.name) && !editMode ? (
          // .md 预览:与 tasks 文档同款渲染（点「编辑」切回 Monaco 源码编辑）。
          <div className="pw-file-md">
            <div className="pw-todo-md">
              <MarkdownView content={preview.content} />
            </div>
          </div>
        ) : (
          <div className="pw-mona-wrap">
            <MonacoViewer
              key={preview.path ?? preview.name}
              value={preview.content}
              language={langForName(preview.name)}
              wordWrap={wordWrapForName(preview.name)}
              readOnly={!editMode}
              onChange={(v) => {
                draftRef.current = v;
                if (editMode) setDirty(v !== preview.content);
              }}
              onSelectionText={(text, anchor) => {
                setSelection(text);
                setSelAnchor(anchor);
              }}
              onSave={() => void save()}
            />
            {/* 选区下方就地浮出发送弹窗（fanbox 同款）;onMouseDown preventDefault 防点击丢选区 */}
            {!editMode && selection && selAnchor ? (
              <div
                className="pw-sel-pop"
                style={{ left: selAnchor.left, top: selAnchor.top }}
                onMouseDown={(e) => e.preventDefault()}
              >
                <button className="pw-ftb-btn" onClick={sendSelectionToTerminal}>
                  <Icon.Terminal size={12} />
                  发送到终端
                </button>
                <button className="pw-ftb-btn" onClick={sendSelectionToChat}>
                  <Icon.Send size={12} />
                  发送到 Chat
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  // 文件名过滤后的顶层子节点（内容搜索模式下不用）。
  const allChildren = tree?.children ?? [];
  const filteredChildren = nameFilter
    ? allChildren.map((c) => filterTree(c, nameFilter)).filter((c): c is PromptNode => c !== null)
    : allChildren;

  return (
    <div className="pw-rp-view">
      <div className="pw-panel-h">
        <div className="pw-rp-seg">
          <button className={mode === "all" ? "is-active" : ""} onClick={() => setMode("all")}>
            全部文件
          </button>
          <button className={mode === "changes" ? "is-active" : ""} onClick={() => setMode("changes")}>
            最近变更
          </button>
        </div>
        <div className="spacer" />
        <button className="pw-icon-btn" title="刷新" onClick={() => void refresh()}>
          <Icon.Workflow size={13} />
        </button>
      </div>
      {mode === "all" ? (
        <div className="pw-rp-search">
          <Icon.Search size={13} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter files… (?text to search contents)"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          {query ? (
            <button className="pw-rp-search-clear" title="清空" onClick={() => setQuery("")}>
              <Icon.X size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
      {mode === "all" ? (
        isContentMode ? (
          !contentKeyword ? (
            <div className="pw-empty-hint">输入要搜索的内容…</div>
          ) : searching && !contentResult ? (
            <div className="pw-panel-empty">搜索中…</div>
          ) : !contentResult || contentResult.files.length === 0 ? (
            <div className="pw-empty-hint">没有匹配「{contentKeyword}」的内容</div>
          ) : (
            <div className="pw-tree pw-search-results">
              {contentResult.files.map((f) => (
                <button
                  key={f.path}
                  className="pw-search-hit"
                  onClick={() => void openFile(f.path, f.name)}
                  onContextMenu={(e) => openCtxMenu(e, f.path, f.name)}
                  title={f.path}
                >
                  <span className="pw-search-hit-head">
                    <TreeRowIcon name={f.name} />
                    <span className="pw-tree-name">{f.rel}</span>
                  </span>
                  {f.lines.map((ln) => (
                    <span key={ln.line} className="pw-search-line">
                      <span className="pw-search-lineno">{ln.line}</span>
                      <span className="pw-search-linetext">{ln.text}</span>
                    </span>
                  ))}
                </button>
              ))}
              {contentResult.truncated ? <div className="pw-empty-hint">结果较多，仅显示部分</div> : null}
            </div>
          )
        ) : !tree ? (
          <div className="pw-panel-empty">加载中…</div>
        ) : (
          <div className="pw-tree">
            <div className="pw-tree-root" title={project.path}>
              {tree.name}
            </div>
            {filteredChildren.length ? (
              filteredChildren.map((c) => (
                <FileTreeNode
                  key={c.path}
                  node={c}
                  depth={0}
                  onOpen={(n) => void openFile(n.path, n.name)}
                  onCtx={openCtxMenu}
                  forceExpand={!!nameFilter}
                />
              ))
            ) : (
              <div className="pw-empty-hint">{nameFilter ? "没有匹配的文件" : "空目录"}</div>
            )}
          </div>
        )
      ) : !changes ? (
        <div className="pw-panel-empty">加载中…</div>
      ) : (
        <div className="pw-tree">
          {!changes.isRepo ? <div className="pw-empty-hint">非 git 仓库 · 按修改时间显示</div> : null}
          {changes.files.length === 0 ? (
            <div className="pw-empty-hint">没有未提交的变更</div>
          ) : (
            changes.files.map((f) => (
              <button
                key={f.path}
                className="pw-tree-row is-file"
                onClick={() => void openChange(f)}
                onContextMenu={(e) => {
                  // 已删除的文件磁盘上不存在,右键操作（打开/插入/删除）均无意义
                  if (f.status !== "D") openCtxMenu(e, f.path, f.rel);
                }}
                title={f.path}
              >
                <span className={`pw-change-badge s-${f.status === "??" ? "new" : f.status[0]}`}>
                  {STATUS_LABEL[f.status] ?? STATUS_LABEL[f.status?.[0] ?? "M"] ?? f.status}
                </span>
                <TreeRowIcon name={f.rel.split("/").pop() ?? f.rel} />
                <span className="pw-tree-name">{f.rel}</span>
              </button>
            ))
          )}
        </div>
      )}
      {ctxMenu ? (
        <FileContextMenu
          target={ctxMenu}
          canOpen={!!bridge?.openPath}
          onOpen={() => ctxOpen(ctxMenu)}
          onInsertChat={() => ctxInsertChat(ctxMenu)}
          onInsertTerminal={() => ctxInsertTerminal(ctxMenu)}
          onDelete={() => void ctxDelete(ctxMenu)}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
    </div>
  );
}
