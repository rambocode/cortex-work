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
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";
import { useDesktopBridge } from "@cortex-work/core/provider";
import { usePersonalStore } from "@cortex-work/core";
import { clampWritingDebounceMs } from "@cortex-work/core/desktop/types";
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
import type { WritingSelectionSnapshot } from "@cortex-work/core/writing/prompt";
import {
  computeWritingDocumentStats,
  isMarkdownFile,
} from "@cortex-work/core/writing/doc-stats";
import { imageExtFromMime, relativeImageLink } from "@cortex-work/core/writing/paste-image";
import {
  buildWritingInlineEditRequest,
  buildWritingInlineEditReviewInput,
  canRunWritingInlineEdit,
} from "@cortex-work/core/writing/inline-edit";
import {
  WRITING_FONT_SIZE_DEFAULT,
  type WritingPreviewMode,
} from "@cortex-work/core/writing/spaces";
import { buildWritingGhostTextExtension } from "./completion/ghost-text";
import { MarkdownView } from "../personal/markdown/MarkdownView";
import {
  NoteCodeMirrorEditor,
  type NoteEditorAppearance,
  type NoteEditorSelection,
} from "../personal/editor/NoteCodeMirrorEditor";
import { useNoteAutosave } from "../personal/notes/useNoteAutosave";
import { WritingDiffReview } from "./WritingDiffReview";
import { WritingToolbar } from "./WritingToolbar";
// 富文本编辑器:本组件顶层无 tiptap(全动态 import),故可静态引用,tiptap 不会被卷进 web 产物。
import { WritingRichEditor } from "./rich/WritingRichEditor";
// PDF 阅读器(U5):顶层仅 `import type` pdfjs(全动态 import),故可静态引用,pdfjs 不会被卷进 web 产物。
import { WritingPdfViewer } from "./pdf/WritingPdfViewer";

// PDF 文件判定(U5):按扩展名分派到只读阅读器,旁路文本档的读盘/自动保存/审阅逻辑。
function isPdfFile(path: string | null): boolean {
  return !!path && /\.pdf$/i.test(path);
}

type Mode = WritingPreviewMode;

// Blob → base64(U1 粘贴图片过 IPC 用)。浏览器无直接 API,逐字节拼再 btoa;
// core 禁 node Buffer,故编码放在 views(浏览器环境,btoa 恒可用)。图片体量有限,逐字节可接受。
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
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
  // 对当前选区执行就地改写(edit 类快捷指令走此):与 ⌘K 同链路(writingInlineEdit → beginReview 红绿 diff)。
  // 返回 {ok, reason}:reason∈ no-selection/unconfigured/mode(选区偏移与源码不匹配,如富文本档)/empty/same/<错误文本>。
  runInlineEditOnSelection: (instruction: string) => Promise<{ ok: boolean; reason?: string }>;
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
  // PDF 文本层选区上报(U5):独立于 CM 选区通道,直接给写作选区快照(sourceKind=pdf + 页码)。
  // 上层(WritingWorkspace)与 CM 通道汇入同一 selection state,故 PDF 选区也能被「引用当前选区」采用。
  onPdfSelectionChange?: (selection: WritingSelectionSnapshot | null) => void;
  onToast?: (msg: string) => void;
  // ── 中栏工具栏接线(WritingWorkspace 注入;standalone 编辑器测试不传则相应控件降级)──
  // 活跃空间根:用于顶栏相对路径展示。
  spaceRoot?: string;
  // 视图档位受控(持久化在 spaces store);缺省时回落组件内部 state(standalone)。
  mode?: WritingPreviewMode;
  onModeChange?: (mode: WritingPreviewMode) => void;
  // 字号 px(顶栏步进,持久化);缺省 16。
  fontSizePx?: number;
  // 聚焦模式(顶栏开关):本组件只透传给工具栏,变灰效果由 .pw-writing-center.is-focus-mode 的 CSS 落地。
  focusMode?: boolean;
  onFocusModeChange?: (on: boolean) => void;
  // 禅模式入口(顶栏按钮):本组件只透传给工具栏,全屏效果由 .pw-writing-root.is-zen 的 CSS 落地。
  onEnterZen?: () => void;
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
      onPdfSelectionChange,
      onToast,
      spaceRoot,
      mode: modeProp,
      onModeChange,
      fontSizePx,
      focusMode,
      onFocusModeChange,
      onEnterZen,
      onFontSizeChange,
      leftCollapsed,
      onToggleLeft,
      assistantOpen,
      onToggleAssistant,
    }: Props,
    ref,
  ): ReactElement {
    const bridge = useDesktopBridge();
    // PDF 档(U5):按扩展名分派到只读阅读器。isPdf 时旁路文本档全部逻辑——不读盘为文本、不自动保存、不审阅。
    const isPdf = isPdfFile(path);

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
    // ── 信息图生成(U7,对接 media-gen)──────────────────────────────────────
    // available:media-gen 图片模态是否已配置(异步探测,未配置则隐藏信息图入口);
    // busy:生成中(跨进程长任务),用于禁用按钮 + 提示;cmSelection:CM 档当前选区(渲染入口按钮 + 定位插入)。
    const [infographicAvailable, setInfographicAvailable] = useState(false);
    const [infographicBusy, setInfographicBusy] = useState(false);
    const infographicBusyRef = useRef(false); // 单飞守卫(同步读,避免并发双发)
    const [cmSelection, setCmSelection] = useState<NoteEditorSelection | null>(null);
    // 命令式句柄读最新选区(edit 类快捷指令从面板触发时,取当下 CM 选区偏移)。
    const cmSelectionRef = useRef(cmSelection);
    cmSelectionRef.current = cmSelection;
    // ── 写作 LLM 续写/改写(U3)──────────────────────────────────────────────
    // llmStatus:写作模型配置态(异步探测)。configured 决定 Cmd-K 与 ghost text 是否可用,
    // completionEnabled 单独门控 ghost text。未配置时两者入口全隐藏(降级)。
    const [llmStatus, setLlmStatus] = useState<{ configured: boolean; completionEnabled: boolean }>({
      configured: false,
      completionEnabled: false,
    });
    // Cmd-K 就地改写:cmdk 记录待改写的选区快照(from/to/text),非空时渲染指令输入条;busy 防并发双发。
    const [cmdk, setCmdk] = useState<{ from: number; to: number; text: string } | null>(null);
    const [cmdkInstruction, setCmdkInstruction] = useState("");
    const [cmdkBusy, setCmdkBusy] = useState(false);
    const cmdkBusyRef = useRef(false);
    // 当前文件的 diff 审阅记录(U6,模块级 review-manager)。存在即切审阅态:只读 + 冻结自动保存。
    // 订阅 store 使 agent/外部在覆盖层外入队的 pending 也能在切回该文件时响应式恢复审阅。
    const pendingReview = useWritingReviewStore((s) => (path ? s.pending[path] : undefined));

    // path 变化:重置 deleted/error,读盘并建立磁盘基线。旧文件的 flush 由 useNoteAutosave 的
    // noteId(=path)切换 effect 兜底,不在此处重复处理。
    useEffect(() => {
      setDeleted(false);
      setLoadError(null);
      // PDF 不走文本读盘(二进制),交阅读器分支渲染;这里直接置空文本态。
      if (!path || isPdf) {
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
    }, [path, bridge, isPdf]);

    // 自动保存(去抖 500ms + 切文件/卸载 flush + 防回灌)。onSave 写盘成功后更新基线并记自写 hash。
    // PDF 档以空 noteId + 空内容彻底脱离自动保存链路,杜绝把空文本 flush 覆盖二进制 PDF 的风险。
    const { draft, setDraft, save, cancel, status } = useNoteAutosave({
      noteId: isPdf ? "" : (path ?? ""),
      content: isPdf ? "" : (loaded?.content ?? ""),
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
    // 写作 LLM 配置态走 ref:供 ghost text 扩展工厂(挂载时建一次)读取最新值,配置改动即时生效不重挂。
    // 续写去抖(ms)读设置的 debounceMs(高级调优),经 ref 供 ghost-text 即时读取(设置改动即时生效)。
    const writingDebounceMs = usePersonalStore((s) => s.writingLlmSettings.debounceMs);
    const writingDebounceMsRef = useRef(writingDebounceMs);
    writingDebounceMsRef.current = writingDebounceMs;
    const llmStatusRef = useRef(llmStatus);
    llmStatusRef.current = llmStatus;

    useImperativeHandle(
      ref,
      (): WritingEditorPaneHandle => ({
        flushNow: () => saveRef.current(),
        markDeleted: () => {
          cancelRef.current(); // 取消挂起去抖保存,避免 flush 写回已删文件
          setDeleted(true);
        },
        // edit 类快捷指令入口:对当前 CM 选区就地改写。与 ⌘K 同链路,但指令由外部(面板)给定。
        runInlineEditOnSelection: async (instruction) => {
          const p = pathRef.current;
          const sel = cmSelectionRef.current;
          const b = bridgeRef.current;
          if (!p || !sel?.text) return { ok: false, reason: "no-selection" };
          if (!llmStatusRef.current.configured || !b?.writingInlineEdit) {
            return { ok: false, reason: "unconfigured" };
          }
          const content = draftRef.current; // 提交时刻快照,偏移与之匹配
          // 偏移校验:富文本档的 from/to 是 PM 位置,不是源码字符偏移,slice 不等即拒绝(避免改错位置)。
          if (content.slice(sel.from, sel.to) !== sel.text) return { ok: false, reason: "mode" };
          const ins = instruction.trim();
          if (!ins) return { ok: false, reason: "empty-instruction" };
          try {
            const req = buildWritingInlineEditRequest(content, sel.from, sel.to, ins);
            const res = await b.writingInlineEdit(req);
            if (!res.ok) return { ok: false, reason: res.message };
            if (!res.replacement) return { ok: false, reason: "empty" };
            const review = buildWritingInlineEditReviewInput(content, sel.from, sel.to, res.replacement);
            const entered = useWritingReviewStore.getState().beginReview({ path: p, ...review });
            return entered ? { ok: true } : { ok: false, reason: "same" };
          } catch (err) {
            return { ok: false, reason: err instanceof Error ? err.message : String(err) };
          }
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

    // 选区变化:既上报给上层(引用/润色),也存本地(U7 CM 档信息图入口按钮 + 定位插入)。
    const handleSelectionChange = (sel: NoteEditorSelection | null): void => {
      setCmSelection(sel);
      onSelectionChange?.(sel);
    };
    // 编辑器不在场(切 preview / 进审阅 / 无文件)时把选区收敛为 null,避免上层残留旧选区。
    const handleSelectionChangeRef = useRef(handleSelectionChange);
    handleSelectionChangeRef.current = handleSelectionChange;
    useEffect(() => {
      if (!editorMounted) handleSelectionChangeRef.current(null);
    }, [editorMounted]);

    // 信息图可用性探测(U7):media-gen 图片模态是否已配置。异步一次性探测,未配置或无能力 → 隐藏入口。
    // 依赖 bridge:壳注入变化(极少)时重探;探测失败一律按未配置(不误显不可用按钮)。
    useEffect(() => {
      const probe = bridge?.writingInfographicAvailable;
      if (!probe) {
        setInfographicAvailable(false);
        return;
      }
      let cancelled = false;
      void probe()
        .then((ok) => {
          if (!cancelled) setInfographicAvailable(ok);
        })
        .catch(() => {
          if (!cancelled) setInfographicAvailable(false);
        });
      return () => {
        cancelled = true;
      };
    }, [bridge]);

    // 写作 LLM 配置态探测(U3):写作模型是否配置 + ghost text 开关。异步探测,未配置/无能力 → 全隐藏入口。
    // 依赖 bridge:壳注入变化时重探;探测失败一律按未配置(不误显不可用的续写/改写)。
    useEffect(() => {
      const probe = bridge?.writingLlmStatus;
      if (!probe) {
        setLlmStatus({ configured: false, completionEnabled: false });
        return;
      }
      let cancelled = false;
      void probe()
        .then((s) => {
          if (!cancelled) setLlmStatus(s);
        })
        .catch(() => {
          if (!cancelled) setLlmStatus({ configured: false, completionEnabled: false });
        });
      return () => {
        cancelled = true;
      };
    }, [bridge]);

    // 额外 CM 扩展工厂:ghost text 续写(U3)+ 空文档占位提示。挂载时以 CM 命名空间构建;isEnabled/requestCompletion 读 ref 取最新配置,
    // 故配置改动即时生效、无需重挂编辑器。仅在 CM 档(live/source)经 NoteCodeMirrorEditor 注入,rich 档不挂。
    // useMemo([]) 保证工厂稳定引用(NoteCodeMirrorEditor 挂载时读一次即可)。
    const buildGhostTextExtensions = useMemo(
      () =>
        (mods: Parameters<typeof buildWritingGhostTextExtension>[0]) =>
          [
            buildWritingGhostTextExtension(mods, {
              // 启用条件:已配置 + ghost text 开关开(读 ref 取最新)。
              isEnabled: () =>
                llmStatusRef.current.configured && llmStatusRef.current.completionEnabled,
              // 去抖读设置的 debounceMs(高级调优),替代硬编码 600ms;设置改动即时生效。
              getDebounceMs: () => clampWritingDebounceMs(writingDebounceMsRef.current),
              requestCompletion: async (prefix, suffix) => {
                const call = bridgeRef.current?.writingComplete;
                if (!call) return null;
                try {
                  const res = await call({ prefix, suffix });
                  return res.ok ? res.completion : null;
                } catch {
                  return null;
                }
              },
            }),
            // 空文档占位提示「开始写作…」(与 rich 档同文案),文档为空时由 CM 自动显示/隐藏。
            // 工厂只在挂载时读一次、live/source 切档不重挂,故两档都注入,由 CSS 只在 live 档显示。
            mods.view.placeholder("开始写作…"),
          ],
      [],
    );

    // 切文件/进审阅/失去 CM 编辑器时,关闭未提交的 Cmd-K 改写输入条(避免选区偏移错位残留)。
    useEffect(() => {
      if (!editorMounted || pendingReview) {
        setCmdk(null);
        setCmdkInstruction("");
      }
    }, [editorMounted, pendingReview, path]);

    // ── 顶栏展示数据 ──────────────────────────────────────────────────────
    const hasTextFile = !!path;
    const fileName = path ? path.split(/[/\\]/).pop() || path : "写作台";
    const fileLabel = path ? relativeWritingPath(spaceRoot ?? "", path) : "尚未打开文件";
    // 字数:仅在有文件时展示;从当前草稿实时计。口径对齐 Kun computeWriteDocumentStats——
    // Markdown 文件先归一为可见文本(剥语法标记、丢链接 URL 与图片 alt)再去空白按 code point 计;
    // 非 Markdown 文件直接按原文去空白计。rich 档编辑的也是同一份 markdown draft,故口径统一。
    const charCount = useMemo(
      () =>
        hasTextFile
          ? computeWritingDocumentStats(draft, isMarkdownFile(path ?? "")).characterCount
          : null,
      [hasTextFile, draft, path],
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

    // 重型导出(U6):当前文档 → 主进程同源渲染 → 弹保存框落盘(DOCX/PDF/HTML/PNG)。
    // 统一走 bridge.writingExport;取消静默、失败 toast、成功 toast 落盘路径。用 draftRef.current
    // 取最新草稿(未落盘也能导出)。任一前置缺失(无 path / 无 bridge 能力)→ 各导出项不渲染。
    const makeHeavyExport = (format: "docx" | "pdf" | "html" | "png"): (() => Promise<void>) | undefined =>
      path && bridge?.writingExport
        ? async (): Promise<void> => {
            try {
              const res = await bridge.writingExport!({ path, content: draftRef.current, format });
              if (res.ok) {
                onToast?.(`已导出到 ${res.path}`);
              } else if (!res.canceled) {
                onToast?.(`导出失败：${res.message}`);
              }
            } catch (err) {
              onToast?.(`导出失败：${err instanceof Error ? err.message : String(err)}`);
            }
          }
        : undefined;
    const onExportDocx = makeHeavyExport("docx");
    const onExportPdf = makeHeavyExport("pdf");
    const onExportHtml = makeHeavyExport("html");
    const onExportPng = makeHeavyExport("png");
    // 复制富文本(U6):渲染成 HTML 写入系统剪贴板(html + text 双写)。
    const onCopyRichText =
      path && bridge?.writingCopyRichText
        ? async (): Promise<void> => {
            try {
              const res = await bridge.writingCopyRichText!({ path, content: draftRef.current });
              onToast?.(res.ok ? "已复制富文本到剪贴板" : `复制失败：${res.message}`);
            } catch (err) {
              onToast?.(`复制失败：${err instanceof Error ? err.message : String(err)}`);
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

    // 粘贴图片落盘(U1):把剪贴板图片写入空间 <spaceRoot>/img/,返回相对当前 md 的链接文本供插入。
    // 需同时具备:打开的文件(算相对路径基准)、空间根(落盘目标)、bridge.writingSaveImage(主进程能力)。
    // 任一缺失 → undefined,rich/CM 粘贴处理不启用,放行默认粘贴(无空间/web 端不拦截)。
    const onPasteImage =
      path && spaceRoot && bridge?.writingSaveImage
        ? async (file: File): Promise<string | null> => {
            try {
              const bytesBase64 = await blobToBase64(file);
              const abs = await bridge.writingSaveImage!({
                spaceRoot,
                bytesBase64,
                ext: imageExtFromMime(file.type),
              });
              return relativeImageLink(path, abs);
            } catch (err) {
              onToast?.(`粘贴图片失败：${err instanceof Error ? err.message : String(err)}`);
              return null;
            }
          }
        : undefined;

    // 信息图生成(U7):选区文本 → 主进程 media-gen 生成 PNG 落 <spaceRoot>/img/ → 返回相对当前 md 的链接。
    // 需同时具备:已配置(available)、打开的文件(相对路径基准)、空间根(落盘目标)、bridge.writingInfographic。
    // 任一缺失 → undefined,rich/CM 入口不出现(未配置/web 端隐藏)。单飞守卫防并发双发;生成中 toast 提示。
    // rich 与 CM 共用此函数:rich 由 WritingRichEditor 拿返回链接插 image 节点;CM 由 runCmInfographic 插入 draft。
    const onInfographic =
      infographicAvailable && path && spaceRoot && bridge?.writingInfographic
        ? async (text: string): Promise<string | null> => {
            if (infographicBusyRef.current) return null; // 一次只生成一张
            const t = text.trim();
            if (!t) {
              onToast?.("请先选中要生成信息图的文字");
              return null;
            }
            infographicBusyRef.current = true;
            setInfographicBusy(true);
            onToast?.("信息图生成中…");
            try {
              const res = await bridge.writingInfographic!({ spaceRoot, text: t });
              if (!res.ok) {
                onToast?.(`信息图生成失败：${res.message}`);
                return null;
              }
              onToast?.("信息图已插入");
              return relativeImageLink(path, res.absolutePath);
            } catch (err) {
              onToast?.(`信息图生成失败：${err instanceof Error ? err.message : String(err)}`);
              return null;
            } finally {
              infographicBusyRef.current = false;
              setInfographicBusy(false);
            }
          }
        : undefined;

    // CM 档(source/live)信息图:用当前选区文本生成 → 把图片链接插入 draft 的光标末端(sel.to)。
    // 竞态:生成为异步长任务,期间用户可能继续编辑使 draft 变短,故插入位置对当前 draft 长度做夹取,避免越界。
    const runCmInfographic = async (): Promise<void> => {
      const sel = cmSelection;
      if (!sel?.text || !onInfographic) return;
      const at = sel.to;
      const rel = await onInfographic(sel.text);
      if (!rel) return;
      const cur = draftRef.current;
      const pos = Math.min(Math.max(at, 0), cur.length);
      setDraft(`${cur.slice(0, pos)}![信息图](${rel})${cur.slice(pos)}`);
    };
    // CM 信息图入口按钮可见性:已配 available + 有 CM 选区 + 处于 CM 档(rich 走浮动工具条自带按钮,不重复)。
    const cmInfographicVisible =
      !!onInfographic && editorMounted && effectiveMode !== "rich" && !!cmSelection?.text;

    // ── Cmd-K 就地改写(U3)──────────────────────────────────────────────────
    // 编辑器区捕获 ⌘K/Ctrl-K:已配置且有非空选区时打开指令输入条(捕获选区快照);否则不拦截(no-op)。
    const onEditorKeyDown = (e: ReactKeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "k") return;
      if (!editorMounted || !canRunWritingInlineEdit(llmStatus.configured, cmSelection?.text)) return;
      e.preventDefault();
      const sel = cmSelection!;
      setCmdk({ from: sel.from, to: sel.to, text: sel.text });
      setCmdkInstruction("");
    };
    // 执行改写:以提交时刻的 draft 快照 + 选区偏移构造请求 → 主进程改写 → 组合全文 next → 复用既有 beginReview
    // 红绿 diff 审阅(不新建第二套 diff,不进聊天历史)。空替换/失败给 toast 不进审阅。
    const runCmdkEdit = async (): Promise<void> => {
      const target = cmdk;
      const p = pathRef.current;
      if (!target || !p || cmdkBusyRef.current) return;
      const instruction = cmdkInstruction.trim();
      if (!instruction) {
        onToast?.("请输入改写指令");
        return;
      }
      const call = bridgeRef.current?.writingInlineEdit;
      if (!call) {
        onToast?.("当前环境不支持就地改写");
        return;
      }
      const content = draftRef.current; // 提交时刻快照:偏移与之匹配,避免 await 期间 draft 变动错位
      cmdkBusyRef.current = true;
      setCmdkBusy(true);
      try {
        const req = buildWritingInlineEditRequest(content, target.from, target.to, instruction);
        const res = await call(req);
        if (!res.ok) {
          onToast?.(`改写失败：${res.message}`);
          return;
        }
        if (!res.replacement) {
          onToast?.("模型未给出有效改写");
          return;
        }
        // 组合全文并入队审阅:baseline=改写前全文、next=改写后全文、origin=agent(既有允许值)。
        const review = buildWritingInlineEditReviewInput(content, target.from, target.to, res.replacement);
        const entered = useWritingReviewStore.getState().beginReview({ path: p, ...review });
        if (!entered) onToast?.("改写结果与原文一致");
        setCmdk(null);
        setCmdkInstruction("");
      } catch (err) {
        onToast?.(`改写失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        cmdkBusyRef.current = false;
        setCmdkBusy(false);
      }
    };

    // ── PDF 档(U5):只读阅读器分支 ─────────────────────────────────────────
    // 复用 WritingToolbar 外壳(hasTextFile=false → 隐藏字号/导出、禁用模式与保存),下方渲染 pdfjs 阅读器。
    // 选区经 onPdfSelectionChange 直报上层,与文本档选区汇入同一 selection state(引用/页码链路复用)。
    if (isPdf && path) {
      return (
        <div className="pw-writing-editor">
          <WritingToolbar
            fileName={fileName}
            fileLabel={fileLabel}
            charCount={null}
            hasTextFile={false}
            mode={mode}
            onModeChange={setMode}
            fontSizePx={fontSizePx ?? WRITING_FONT_SIZE_DEFAULT}
            saveStatus="saved"
            saveLabel="PDF"
            onSave={() => {}}
            saveDisabled
            leftCollapsed={leftCollapsed}
            onToggleLeft={onToggleLeft}
            assistantOpen={assistantOpen}
            onToggleAssistant={onToggleAssistant}
          />
          <div className="pw-writing-editor-main" style={{ position: "relative" }}>
            <WritingPdfViewer key={path} filePath={path} onSelectionChange={onPdfSelectionChange} />
          </div>
        </div>
      );
    }

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
        focusMode={focusMode}
        onFocusModeChange={onFocusModeChange}
        onEnterZen={onEnterZen}
        leftCollapsed={leftCollapsed}
        onToggleLeft={onToggleLeft}
        assistantOpen={assistantOpen}
        onToggleAssistant={onToggleAssistant}
        onCopyMarkdown={onCopyMarkdown}
        onExportMarkdownCopy={onExportMarkdownCopy}
        onExportDocx={onExportDocx}
        onExportPdf={onExportPdf}
        onExportHtml={onExportHtml}
        onExportPng={onExportPng}
        onCopyRichText={onCopyRichText}
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
        onSelectionChange={handleSelectionChange}
        onSave={() => void save()}
        onPasteImage={onPasteImage}
        // ghost text 续写扩展(U3):CM 档注入;isEnabled/请求读 ref,未配置/关闭时扩展内部自门控不显不请求。
        buildExtraExtensions={buildGhostTextExtensions}
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
                onSelectionChange={handleSelectionChange}
                onSaveShortcut={() => void save()}
                onToast={onToast}
                onLoadError={() => {
                  setEditorLoadFailed(true);
                  onToast?.("富文本编辑器加载失败,已切换到仅预览");
                }}
                resolveImageSrc={resolveImageSrc}
                onPasteImage={onPasteImage}
                onInfographic={onInfographic}
                infographicBusy={infographicBusy}
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
        {/* position:relative 供 CM 信息图入口按钮绝对定位(rich 档用浮动工具条自带按钮,不在此渲染)。
            onKeyDownCapture 捕获 ⌘K/Ctrl-K 就地改写:在 CM 处理前拦截,有选区+已配置才生效。*/}
        <div
          className="pw-writing-editor-main"
          style={{ position: "relative" }}
          onKeyDownCapture={onEditorKeyDown}
        >
          {body}
          {/* Cmd-K 改写指令输入条:选区改写时浮现在编辑器顶部。Enter 提交 / Esc 关闭。 */}
          {cmdk ? (
            <div
              className="pw-writing-cmdk"
              style={{
                position: "absolute",
                left: 16,
                right: 16,
                top: 12,
                zIndex: 6,
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: 8,
                borderRadius: 8,
                background: "var(--surface-1, #fff)",
                boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
              }}
            >
              <input
                className="pw-set-input"
                autoFocus
                style={{ flex: 1 }}
                value={cmdkInstruction}
                placeholder="输入改写指令,如「更正式」「精简一半」…"
                disabled={cmdkBusy}
                onChange={(e) => setCmdkInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runCmdkEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setCmdk(null);
                    setCmdkInstruction("");
                  }
                }}
              />
              <button
                type="button"
                className="pw-tl-gen"
                disabled={cmdkBusy || !cmdkInstruction.trim()}
                onClick={() => void runCmdkEdit()}
              >
                {cmdkBusy ? "改写中…" : "改写"}
              </button>
              <button
                type="button"
                className="pw-btn-sm"
                disabled={cmdkBusy}
                onClick={() => {
                  setCmdk(null);
                  setCmdkInstruction("");
                }}
              >
                取消
              </button>
            </div>
          ) : null}
          {cmInfographicVisible ? (
            <button
              type="button"
              className="pw-tl-gen"
              style={{ position: "absolute", right: 16, bottom: 16, zIndex: 5 }}
              title="用选中文字生成信息图"
              disabled={infographicBusy}
              onClick={() => void runCmInfographic()}
            >
              {infographicBusy ? "信息图生成中…" : "生成信息图"}
            </button>
          ) : null}
        </div>
      </div>
    );
  },
);
