// 写作工作区中栏:文件版三档 Markdown 编辑器(源码 / 实时预览 / 仅预览)。
// 与闪记编辑器同构,但主键是「文件绝对路径」而非闪记 id:
//   - 加载:path 变化时经 bridge.readFile 读盘 → 建立磁盘基线(baseline.setBaseline);
//   - 保存:复用 useNoteAutosave(500ms 去抖 + 切文件/卸载 flush + 防回灌),onSave=bridge.writeFile,
//           保存成功后更新基线并记自写 hash(baseline.recordSelfWrite,供归因抑制自回声);
//   - 命令式钩子(useImperativeHandle,供 U8/U9 调用):
//       flushNow()             发送前 flush 保存(U8);
//       handleExternalChange() 收到「盘上被改」信号 → 干净静默刷新 / 脏转交冲突审阅(U9→U6);
//       markDeleted()          当前文件被删信号 → deleted 态(提示+另存+停自动保存)。
// 编辑器内核 NoteCodeMirrorEditor 走 CM6 动态 import(views 被 Next.js 双打包),本壳不改其本体。

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useDesktopBridge } from "@cortex-work/core/provider";
import {
  getBaseline,
  isSelfEcho,
  recordSelfWrite,
  setBaseline,
} from "@cortex-work/core/writing/baseline";
import {
  resolveWritingReview,
  useWritingReviewStore,
} from "@cortex-work/core/writing/review-manager";
import { relativeWritingPath } from "@cortex-work/core/writing/prompt";
import {
  WRITING_FONT_SIZE_DEFAULT,
  type WritingPreviewMode,
} from "@cortex-work/core/writing/spaces";
import { MarkdownView } from "../personal/MarkdownView";
import {
  NoteCodeMirrorEditor,
  type NoteEditorAppearance,
  type NoteEditorSelection,
} from "../personal/editor/NoteCodeMirrorEditor";
import { useNoteAutosave } from "../personal/useNoteAutosave";
import { WritingDiffReview } from "./WritingDiffReview";
import { WritingToolbar } from "./WritingToolbar";
// 富文本编辑器:本组件顶层无 tiptap(全动态 import),故可静态引用,tiptap 不会被卷进 web 产物。
import { WritingRichEditor } from "./rich/WritingRichEditor";

type Mode = WritingPreviewMode;

// 字数统计(对齐 Kun computeWriteDocumentStats 的口径:去掉所有空白后按 code point 计数)。
// 差异:Kun 会先把 Markdown 解析成可见文本再去空白;本仓库无 tiptap 解析器,直接按原文去空白计,
// 故含少量 Markdown 语法字符,数值略高于 Kun。属可接受近似(见回报)。
function countVisibleChars(text: string): number {
  return Array.from(text.replace(/\s+/g, "")).length;
}

const SAVE_HINT: Record<ReturnType<typeof useNoteAutosave>["status"], string> = {
  idle: "已保存",
  dirty: "未保存",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败",
};

// handleExternalChange 的归因结果(U9 据此决定后续动作;也便于单测断言分支)。
export type ExternalChangeStatus =
  | "no-file" // 无打开文件
  | "no-bridge" // 环境无 readFile 能力
  | "read-error" // 读盘失败
  | "ignored-echo" // 自写回声,忽略
  | "unchanged" // 盘上内容与基线一致,无变化
  | "refreshed" // 编辑器干净:已静默重读刷新
  | "conflict"; // 编辑器脏:已转交冲突审阅(onConflict)

export interface ExternalChangeResult {
  status: ExternalChangeStatus;
  disk?: string;
}

// 命令式句柄:供 U8(发送前 flush)与 U9(归因回路)在组件外驱动编辑器。
export interface WritingEditorPaneHandle {
  // 立即 flush 挂起的自动保存(发送前调用,确保 agent 读到最新盘面)。
  flushNow: () => Promise<void>;
  // 收到「当前文件盘上被改」信号:干净静默刷新 / 脏转交冲突审阅。返回归因结果。
  handleExternalChange: () => Promise<ExternalChangeResult>;
  // 当前文件被删信号:进入 deleted 态并停自动保存。
  markDeleted: () => void;
}

interface Props {
  // 当前打开文件绝对路径(树节点 key);null 表示无打开文件。
  path: string | null;
  // 脏态遇外部改动时的冲突审阅入口(U6 接):基线=编辑器当前内容,新版=盘上内容。
  onConflict?: (info: { path: string; baseline: string; disk: string }) => void;
  // 审阅态(U6)需要冻结编辑;deleted 态由内部管理,两者取或。
  readOnly?: boolean;
  // 编辑器选区变化上报(R11):有选区传快照,空选区/非编辑态传 null。上层据此解禁「引用选中/润色」。
  onSelectionChange?: (selection: NoteEditorSelection | null) => void;
  onToast?: (msg: string) => void;
  // ── 中栏工具栏接线(WritingWorkspace 注入;standalone 编辑器测试不传则相应控件降级)──
  // 活跃空间根:用于顶栏相对路径展示。
  spaceRoot?: string;
  // 视图档位受控(持久化在 spaces store);缺省时回落组件内部 state(standalone)。
  mode?: WritingPreviewMode;
  onModeChange?: (mode: WritingPreviewMode) => void;
  // 字号 px(顶栏步进,持久化);缺省 16。
  fontSizePx?: number;
  onFontSizeChange?: (px: number) => void;
  // 左栏折叠 / 右侧助手栏开合(顶栏两个按钮),由 WritingWorkspace 持有。
  leftCollapsed?: boolean;
  onToggleLeft?: () => void;
  assistantOpen?: boolean;
  onToggleAssistant?: () => void;
}

export const WritingEditorPane = forwardRef<WritingEditorPaneHandle, Props>(
  function WritingEditorPane(
    {
      path,
      onConflict,
      readOnly,
      onSelectionChange,
      onToast,
      spaceRoot,
      mode: modeProp,
      onModeChange,
      fontSizePx,
      onFontSizeChange,
      leftCollapsed,
      onToggleLeft,
      assistantOpen,
      onToggleAssistant,
    }: Props,
    ref,
  ): ReactElement {
    const bridge = useDesktopBridge();

    // 视图档位:优先受控(WritingWorkspace 持久化),否则回落内部 state(standalone)。
    const [internalMode, setInternalMode] = useState<Mode>("live");
    const mode: Mode = modeProp ?? internalMode;
    const setMode = onModeChange ?? setInternalMode;
    // CodeMirror 动态装载失败 → 强制只读「仅预览」(复用 MarkdownView,不依赖 CM)。
    const [editorLoadFailed, setEditorLoadFailed] = useState(false);
    // 当前已加载文件内容(异步读盘结果);null 表示尚未加载(loading)或无文件。
    const [loaded, setLoaded] = useState<{ path: string; content: string } | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    // 当前文件被删:提示 + 另存 + 冻结,避免静默丢未保存内容(R8)。
    const [deleted, setDeleted] = useState(false);
    // 当前文件的 diff 审阅记录(U6,模块级 review-manager)。存在即切审阅态:只读 + 冻结自动保存。
    // 订阅 store 使 agent/外部在覆盖层外入队的 pending 也能在切回该文件时响应式恢复审阅。
    const pendingReview = useWritingReviewStore((s) => (path ? s.pending[path] : undefined));

    // path 变化:重置 deleted/error,读盘并建立磁盘基线。旧文件的 flush 由 useNoteAutosave 的
    // noteId(=path)切换 effect 兜底,不在此处重复处理。
    useEffect(() => {
      setDeleted(false);
      setLoadError(null);
      if (!path) {
        setLoaded(null);
        return;
      }
      if (!bridge?.readFile) {
        setLoadError("当前环境不支持读取文件");
        setLoaded(null);
        return;
      }
      let cancelled = false;
      // 立即置 loading:避免短暂显示上一个文件的旧内容。
      setLoaded(null);
      void bridge
        .readFile(path)
        .then((res) => {
          if (cancelled) return;
          setLoaded({ path, content: res.content });
          setBaseline(path, res.content); // 加载即建立/刷新基线
        })
        .catch((err) => {
          if (cancelled) return;
          setLoadError(err instanceof Error ? err.message : String(err));
        });
      return () => {
        cancelled = true;
      };
    }, [path, bridge]);

    // 自动保存(去抖 500ms + 切文件/卸载 flush + 防回灌)。onSave 写盘成功后更新基线并记自写 hash。
    const { draft, setDraft, save, cancel, status } = useNoteAutosave({
      noteId: path ?? "",
      content: loaded?.content ?? "",
      onSave: async (content) => {
        if (!path || !bridge?.writeFile) return;
        await bridge.writeFile(path, content);
        // 保存成功:基线推进到已落盘内容,并记自写 hash(watch 回声抑制,见 baseline.isSelfEcho)。
        setBaseline(path, content);
        recordSelfWrite(path, content);
      },
      onError: (err) => onToast?.(`保存失败：${err instanceof Error ? err.message : String(err)}`),
    });

    // draft/path 走 ref,供命令式句柄读取「最新已提交值」(句柄在渲染间被外部调用)。
    const draftRef = useRef(draft);
    const pathRef = useRef(path);
    const saveRef = useRef(save);
    const cancelRef = useRef(cancel);
    draftRef.current = draft;
    pathRef.current = path;
    saveRef.current = save;
    cancelRef.current = cancel;

    // onConflict 走 ref,避免句柄依赖其引用变化。
    const onConflictRef = useRef(onConflict);
    onConflictRef.current = onConflict;
    const bridgeRef = useRef(bridge);
    bridgeRef.current = bridge;

    useImperativeHandle(
      ref,
      (): WritingEditorPaneHandle => ({
        flushNow: () => saveRef.current(),
        markDeleted: () => {
          cancelRef.current(); // 取消挂起去抖保存,避免 flush 写回已删文件
          setDeleted(true);
        },
        handleExternalChange: async (): Promise<ExternalChangeResult> => {
          const p = pathRef.current;
          if (!p) return { status: "no-file" };
          const b = bridgeRef.current;
          if (!b?.readFile) return { status: "no-bridge" };
          let disk: string;
          try {
            disk = (await b.readFile(p)).content;
          } catch {
            return { status: "read-error" };
          }
          // ① 自写回声:盘上内容 = 本端上次所写 → 忽略(不刷新/不审阅)。
          if (isSelfEcho(p, disk)) return { status: "ignored-echo" };
          const bl = getBaseline(p);
          // ② 与基线一致:外部信号但内容没变,忽略。
          if (bl && bl.content === disk) return { status: "unchanged" };
          const draftNow = draftRef.current;
          const baselineContent = bl?.content ?? draftNow;
          const clean = draftNow === baselineContent;
          if (clean) {
            // ③ 干净:静默重读刷新(NoteCodeMirrorEditor 经 externalSync 保光标),基线同步盘面。
            setLoaded({ path: p, content: disk });
            setBaseline(p, disk);
            return { status: "refreshed", disk };
          }
          // ④ 脏:不静默覆盖,转交冲突审阅(基线=编辑器当前内容,新版=盘上内容;复用 diff 通道)。
          onConflictRef.current?.({ path: p, baseline: draftNow, disk });
          return { status: "conflict", disk };
        },
      }),
      [],
    );

    // 另存为:文件被删后保住未保存内容。经系统目录选择器选目标目录,写入同名文件。
    const saveAs = async (): Promise<void> => {
      if (!bridge?.pickDirectory || !bridge?.writeFile) {
        onToast?.("当前环境不支持另存");
        return;
      }
      const dir = await bridge.pickDirectory();
      if (!dir) return; // 用户取消
      const name = path ? path.split(/[/\\]/).pop() || "untitled.md" : "untitled.md";
      const dest = `${dir.replace(/[/\\]+$/, "")}/${name}`;
      try {
        await bridge.writeFile(dest, draftRef.current);
        onToast?.(`已另存到 ${dest}`);
      } catch (err) {
        onToast?.(`另存失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };

    // 进入审阅态:取消挂起的自动保存(冻结),避免审阅期间写盘覆盖 agent 改动。
    useEffect(() => {
      if (pendingReview) cancelRef.current();
    }, [pendingReview]);

    // 裁决落盘:按用户选定内容写盘 → 推进基线 → 清 pending(解冻);随后把编辑器内容同步到裁决结果。
    const resolveReview = async (accepted: string): Promise<void> => {
      const p = pathRef.current;
      if (!p) return;
      const b = bridgeRef.current;
      if (!b?.writeFile) {
        onToast?.("当前环境不支持写入文件");
        return;
      }
      try {
        await resolveWritingReview(p, accepted, (fp, c) => b.writeFile(fp, c));
        // 同步编辑器内容到裁决结果(loaded 变更经 useNoteAutosave 的 content prop 回灌 draft)。
        setLoaded({ path: p, content: accepted });
      } catch (err) {
        onToast?.(`落盘失败：${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const effectiveMode: Mode = editorLoadFailed ? "preview" : mode;
    // deleted / 外部只读 / 审阅态都冻结编辑。
    const frozen = deleted || !!readOnly || !!pendingReview;
    // CM 编辑器是否在场:仅 source/live 且非审阅态才挂载。preview / diff 审阅无 CM,选区不可用。
    const editorMounted = !!path && !!loaded && !loadError && !pendingReview && effectiveMode !== "preview";

    // 编辑器不在场(切 preview / 进审阅 / 无文件)时把选区收敛为 null,避免上层残留旧选区。
    const onSelectionChangeRef = useRef(onSelectionChange);
    onSelectionChangeRef.current = onSelectionChange;
    useEffect(() => {
      if (!editorMounted) onSelectionChangeRef.current?.(null);
    }, [editorMounted]);

    // ── 顶栏展示数据 ──────────────────────────────────────────────────────
    const hasTextFile = !!path;
    const fileName = path ? path.split(/[/\\]/).pop() || path : "写作台";
    const fileLabel = path ? relativeWritingPath(spaceRoot ?? "", path) : "尚未打开文件";
    // 字数:仅在有文件时展示;从当前草稿实时计。
    const charCount = useMemo(
      () => (hasTextFile ? countVisibleChars(draft) : null),
      [hasTextFile, draft],
    );
    // 保存禁用:无文件 / 冻结(删除·审阅·只读)/ 无写盘能力。
    const saveDisabled = !path || frozen || !bridge?.writeFile;

    // 导出:复制全文到剪贴板;导出 .md 副本(选目录写同名文件)。均复用当前草稿 + bridge,低成本等价 Kun 导出。
    const onCopyMarkdown = path
      ? async (): Promise<void> => {
          try {
            if (typeof navigator === "undefined" || !navigator.clipboard) {
              onToast?.("当前环境不支持复制");
              return;
            }
            await navigator.clipboard.writeText(draftRef.current);
            onToast?.("已复制全文到剪贴板");
          } catch (err) {
            onToast?.(`复制失败：${err instanceof Error ? err.message : String(err)}`);
          }
        }
      : undefined;
    const onExportMarkdownCopy =
      path && bridge?.pickDirectory && bridge?.writeFile
        ? async (): Promise<void> => {
            const dir = await bridge.pickDirectory!();
            if (!dir) return;
            const name = path.split(/[/\\]/).pop() || "untitled.md";
            const dest = `${dir.replace(/[/\\]+$/, "")}/${name}`;
            try {
              await bridge.writeFile!(dest, draftRef.current);
              onToast?.(`已导出到 ${dest}`);
            } catch (err) {
              onToast?.(`导出失败：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        : undefined;

    // 富文本本地图片显示解析:相对路径按当前 .md 目录拼绝对(不做 ../ 折叠,常见 ./x 足够),
    // 再经 bridge.imageReadAny 读成 data URL;绝对/远程直接由节点视图使用,不进这里。
    const resolveImageSrc =
      path && bridge?.imageReadAny
        ? async (rawSrc: string): Promise<string | null> => {
            const dir = path.replace(/[/\\][^/\\]*$/, "");
            const abs = rawSrc.startsWith("/") ? rawSrc : `${dir}/${rawSrc.replace(/^\.\//, "")}`;
            try {
              return (await bridge.imageReadAny!(abs)).dataUrl;
            } catch {
              return null;
            }
          }
        : undefined;

    const toolbar = (
      <WritingToolbar
        fileName={fileName}
        fileLabel={fileLabel}
        charCount={charCount}
        hasTextFile={hasTextFile}
        mode={mode}
        onModeChange={setMode}
        modeLocked={editorLoadFailed}
        fontSizePx={fontSizePx ?? WRITING_FONT_SIZE_DEFAULT}
        onFontSizeChange={onFontSizeChange}
        saveStatus={status}
        saveLabel={SAVE_HINT[status]}
        onSave={() => void save()}
        saveDisabled={saveDisabled}
        leftCollapsed={leftCollapsed}
        onToggleLeft={onToggleLeft}
        assistantOpen={assistantOpen}
        onToggleAssistant={onToggleAssistant}
        onCopyMarkdown={onCopyMarkdown}
        onExportMarkdownCopy={onExportMarkdownCopy}
      />
    );

    // CM 编辑器(source/live);也作为 rich 审计不通过时的回落。抽成函数以便两处复用。
    const renderCmEditor = (appearance: NoteEditorAppearance): ReactElement => (
      <NoteCodeMirrorEditor
        // key 含 path:切文件重建实例,避免旧文档残留(与闪记按 noteId 重建同理)。
        key={path}
        value={draft}
        appearance={appearance}
        readOnly={frozen}
        onChange={setDraft}
        onSelectionChange={onSelectionChange}
        onSave={() => void save()}
        onLoadError={() => {
          setEditorLoadFailed(true);
          onToast?.("编辑器加载失败,已切换到仅预览");
        }}
      />
    );

    // ── 主体:无文件 / 读取失败 / 加载中 / 编辑器(+ deleted 条)。工具栏恒显于顶部(照 Kun)。──
    let body: ReactElement;
    if (!path) {
      body = <div className="pw-writing-editor-empty">从左侧选择或新建一个文件开始写作</div>;
    } else if (loadError) {
      body = <div className="pw-writing-editor-empty">读取失败：{loadError}</div>;
    } else if (!loaded) {
      body = <div className="pw-writing-editor-empty">加载中…</div>;
    } else {
      body = (
        <>
          {deleted ? (
            <div className="pw-writing-deleted-bar" role="alert">
              <span>文件已被删除,未保存内容仍在编辑器中。</span>
              <button type="button" className="pw-tl-gen" onClick={() => void saveAs()}>
                另存为…
              </button>
            </div>
          ) : null}
          <div className="pw-note-editor-body">
            {pendingReview ? (
              // 审阅态:红绿 diff 逐块裁决(基线 → 新版)。裁决完毕经 resolveReview 落盘并解冻。
              // 任意档位进入审阅都让位给 diff 视图(rich 也退出),裁决完再回到原档。
              <WritingDiffReview
                key={`${path}:review`}
                path={path}
                baseline={pendingReview.baseline}
                next={pendingReview.next}
                onResolve={(accepted) => void resolveReview(accepted)}
              />
            ) : effectiveMode === "rich" ? (
              // 富文本(所见即所得)。审计不通过时组件内部渲染 fallback(CM live),保护原文不被静默改写。
              <WritingRichEditor
                key={`${path}:rich`}
                value={draft}
                filePath={path}
                readOnly={frozen}
                onChange={setDraft}
                onSelectionChange={onSelectionChange}
                onSaveShortcut={() => void save()}
                onToast={onToast}
                onLoadError={() => {
                  setEditorLoadFailed(true);
                  onToast?.("富文本编辑器加载失败,已切换到仅预览");
                }}
                resolveImageSrc={resolveImageSrc}
                fallback={renderCmEditor("live")}
              />
            ) : effectiveMode === "preview" ? (
              // 复用闪记同款「仅预览」容器 .pw-note-editor-preview:70px 版心 + 对齐 Kun 的文档排版
              // (标题层级/间距/代码块),避免写作预览沿用紧凑的 .pw-todo-md 详情卡样式导致混乱。
              <div className="pw-note-editor-preview">
                {editorLoadFailed ? (
                  <div className="pw-empty-hint">编辑器加载失败,当前仅可预览。</div>
                ) : null}
                {draft.trim() ? (
                  <div className="pw-todo-md pw-note-md">
                    <MarkdownView content={draft} />
                  </div>
                ) : (
                  <div className="pw-empty-hint">空白文件</div>
                )}
              </div>
            ) : (
              renderCmEditor(effectiveMode as NoteEditorAppearance)
            )}
          </div>
        </>
      );
    }

    return (
      <div className={`pw-writing-editor${!loaded || !path || loadError ? " is-bodyempty" : ""}`}>
        {toolbar}
        <div className="pw-writing-editor-main">{body}</div>
      </div>
    );
  },
);
