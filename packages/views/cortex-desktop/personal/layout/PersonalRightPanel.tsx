// 个人工作区右栏通用宿主。渲染哪个面板、标题/宽度档/放大策略/自定义头,全部由
// personal/right-panel/registry 的 descriptor 驱动——本文件不认识任何具体面板,
// 新增面板零改动（写 descriptor + registry 加一行即可,2026-08-21 注册表重构共识）。
// 面板主体经 React.lazy 懒加载（独立 chunk,首开才解析）;头部/拖拽条/放大按钮是宿主
// chrome,同步渲染。视图由最右侧竖向工具栏选择（状态在 usePersonalStore.rightView）。
// 仅查看文件（Tasks 详情 / 文件预览）时左缘可拖拽调宽（宽度经 --rp-custom-width
// 注入,只作用于详情态的 CSS 档位,返回列表恢复固定 320px）;双击恢复自动宽度。
// 拖拽条的显示时机由 CSS :has 控制（见 .pw-rp-resizer）。

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef } from "react";
import type * as React from "react";
import { Icon } from "@cortex-work/ui/icons";
import { useCortexUIStore, usePersonalStore } from "@cortex-work/core";
import { resolvePanel } from "../right-panel/registry";
import { PanelHostProvider, type PanelHost } from "../right-panel/context";
import { openPanel } from "../right-panel/open";
import { PresenceGuard } from "../right-panel/PresenceGuard";
import { PanelHeadTitle } from "../right-panel/PanelHeadTitle";
import type { RightPanelDescriptor } from "../right-panel/types";

// 导出供测试引用,调参不破坏断言。
export const RP_MIN_WIDTH = 280;
/// 右侧 rail 的占位宽:与 CSS 的 .pw-right-rail width(48px)/--rp-avail 同一个数,改一处必改两处。
export const RP_RAIL_SAFE = 48;
// 左侧内容(中栏)至少保留的宽度。拖拽上限至少保留拖拽开始时已经渲染出来的宽度,
// 避免第一帧把面板夹小造成可见边界向右跳。
// 488 = 中栏最小宽 440(CSS 的 --pw-center-min)+ 右侧 rail 48;与 CSS 各档
// min-width 公式是同一基准,改一处必须同步另一处。
export const RP_LEFT_RESERVED = 488;
// 宽面板(widthTier="wide":产物/研究/知识库/画板/文件预览)例外:默认就展得很宽,
// 若沿用 250px 的保留,中栏会被压成放不下消息气泡与输入框控件的窄条,故把中栏下限抬到 660px。
// 与 CSS 里 .pw-prompts:has(.pw-artifact-editor) / :has(.pw-research-panel) 的默认宽度公式
// 是同一个数,改一处要改三处(两条 CSS 规则 + 本常量)。
export const RP_LEFT_RESERVED_ARTIFACT = 660;

/// 拖拽调宽时给中栏保留的最小宽度:按 descriptor 的 widthTier 二档取值。
function reservedWidthFor(desc: RightPanelDescriptor): number {
  return desc.widthTier === "wide" ? RP_LEFT_RESERVED_ARTIFACT : RP_LEFT_RESERVED;
}

/// 放大（绝对定位盖住中栏）判定:canMaximize 的 "filePreview" 数据令牌表示
/// 仅文件打开预览态开放（列表态盖上去用户会以为会话不见了,files 专用）。
function canMaximizeFor(desc: RightPanelDescriptor, filePreviewOpen: boolean): boolean {
  return desc.canMaximize === true || (desc.canMaximize === "filePreview" && filePreviewOpen);
}

// React.lazy 组件按面板 id 做模块级缓存:每次 render 重建 lazy 会让面板反复卸载重挂
// （丢内部状态、BrowserView 的 webview 重载）,缓存保证组件身份稳定。
const lazyPanelCache = new Map<string, React.LazyExoticComponent<React.ComponentType>>();
function lazyPanel(desc: RightPanelDescriptor): React.LazyExoticComponent<React.ComponentType> {
  let cached = lazyPanelCache.get(desc.id);
  if (!cached) {
    cached = lazy(desc.load);
    lazyPanelCache.set(desc.id, cached);
  }
  return cached;
}

export function PersonalRightPanel({ onToast }: { onToast: (text: string) => void }) {
  const view = usePersonalStore((s) => s.rightView);
  // 未知 id（脏运行态/已卸载的未来动态面板）回退 files,宿主绝不因 id 不认识而崩。
  const desc = resolvePanel(view);
  const filePreviewOpen = usePersonalStore((s) => s.filePreviewOpen);
  const width = usePersonalStore((s) => s.rightPanelWidth);
  const maximized = usePersonalStore((s) => s.rightPanelMaximized);
  const setMaximized = usePersonalStore((s) => s.setRightPanelMaximized);
  const setWidth = usePersonalStore((s) => s.setRightPanelWidth);
  const setRightOpen = useCortexUIStore((s) => s.setRightOpen);
  const cancelResizeRef = useRef<(() => void) | null>(null);
  const activeSessionId = usePersonalStore((s) => s.activeSessionId);
  const activeProjectPath = usePersonalStore((s) => {
    const session = s.sessions.find((item) => item.id === s.activeSessionId);
    return s.projects.find((project) => project.id === session?.projectId)?.path ?? session?.noProjectDir ?? "";
  });

  const canMax = canMaximizeFor(desc, filePreviewOpen);

  // 切到不可放大的视图(或文件预览退回列表)时自动还原,避免窄面板盖着中栏让用户以为会话不见了。
  useEffect(() => {
    if (!canMax && maximized) setMaximized(false);
  }, [canMax, maximized, setMaximized]);
  useEffect(() => () => cancelResizeRef.current?.(), []);

  const close = useCallback(() => setRightOpen(false), [setRightOpen]);

  // PanelHost 软合同:面板 wrapper 的共性依赖注入点（见 right-panel/context.tsx）。
  const host = useMemo<PanelHost>(
    () => ({
      panelId: desc.id,
      close,
      openPanel,
      toast: onToast,
      activeSessionId,
      projectPath: activeProjectPath,
    }),
    [desc.id, close, onToast, activeSessionId, activeProjectPath],
  );

  const startResize = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      cancelResizeRef.current?.();
      const aside = e.currentTarget.parentElement;
      if (!aside) return;
      const rect = aside.getBoundingClientRect();
      const startX = e.clientX;
      const parentRect = aside.parentElement?.getBoundingClientRect();
      const parentWidth = parentRect?.width || window.innerWidth;
      const startWidth = rect.width || RP_MIN_WIDTH;
      // 用位移增量算宽度,不依赖 rect.left/right 是否等于视觉拖拽条位置。正常状态给
      // 左侧保留空间;若起始布局已经超过这个保留区,本次拖拽允许到父容器宽度,不能反向夹小。
      const reserved = reservedWidthFor(resolvePanel(view));
      const reservedMax = Math.max(RP_MIN_WIDTH, parentWidth - reserved);
      // 硬上限与 CSS 的 --rp-avail(calc(100% - 48px),给右侧 rail 留位)同界:拖拽写入的
      // 宽度不会被 CSS 再夹(无首帧跳变),也不可能把面板头部 X/右栏 rail 推出视口。
      const hardMax = Math.max(RP_MIN_WIDTH, parentWidth - RP_RAIL_SAFE);
      const max = Math.min(
        hardMax,
        startWidth > reservedMax ? Math.max(RP_MIN_WIDTH, startWidth, parentWidth) : reservedMax,
      );
      // || 兜底:未布局时 rect 宽为 0（如测试环境）。只有实际水平移动后才会提交。
      let nextWidth = startWidth;
      let moved = false;
      const onMove = (ev: MouseEvent) => {
        if (ev.clientX === startX && !moved) return;
        moved = true;
        nextWidth = Math.round(
          Math.min(max, Math.max(RP_MIN_WIDTH, startWidth + (startX - ev.clientX))),
        );
        // 拖拽中直接写 DOM 的 CSS 变量,绕过 React 重渲染 —— 否则每帧都 setWidth 会
        // 重渲染整棵右栏(含 BrowserView/webview),造成拖动抖动。松手才提交一次 store。
        aside.style.setProperty("--rp-custom-width", `${nextWidth}px`);
      };
      let finished = false;
      const finishResize = (commit: boolean) => {
        if (finished) return;
        finished = true;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onBlur);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
        // 拖拽结束:恢复内嵌浏览器(webview/iframe)的指针事件。
        document.body.classList.remove("pw-rp-resizing");
        // 提交最终宽度:持久化 + 让后续渲染沿用(与拖拽中直写的 DOM 变量值一致,无跳变)。
        if (commit && moved) setWidth(nextWidth);
        if (cancelResizeRef.current === cancelResize) cancelResizeRef.current = null;
      };
      const onUp = () => finishResize(true);
      const onBlur = () => finishResize(true);
      const cancelResize = () => finishResize(false);
      cancelResizeRef.current = cancelResize;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      // 拖拽期间禁用内嵌浏览器帧的指针事件,否则鼠标移到 webview/iframe 上时
      // 事件被其捕获,document 收不到 mouseup —— 表现为「松手无效、宽度一直跟随鼠标」。
      document.body.classList.add("pw-rp-resizing");
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onBlur);
    },
    [setWidth, view],
  );

  const Body = lazyPanel(desc);
  const RenderHead = desc.renderHead;

  return (
    <aside
      className={`right pw-prompts${maximized ? " is-maximized" : ""}`}
      data-right-view={view}
      style={
        width
          ? ({ "--rp-custom-width": `${width}px` } as React.CSSProperties)
          : undefined
      }
    >
      <div
        className="pw-rp-resizer"
        title="拖动调整宽度,双击恢复自动"
        onMouseDown={startResize}
        onDoubleClick={() => setWidth(undefined)}
      />
      {desc.headMode === "none" ? null : (
        <div className={`pw-col-head pw-rp-head${desc.headClassName ? ` ${desc.headClassName}` : ""}`}>
          {RenderHead ? <RenderHead /> : <PanelHeadTitle title={desc.title} />}
          {canMax ? (
            <button
              className="pw-icon-btn"
              title={maximized ? "还原面板" : "放大面板"}
              onClick={() => setMaximized(!maximized)}
            >
              {maximized ? <Icon.Minimize size={14} /> : <Icon.Maximize size={14} />}
            </button>
          ) : null}
          <button className="pw-icon-btn" title="关闭面板" onClick={close}>
            <Icon.X size={14} />
          </button>
        </div>
      )}
      {/* Provider 在 Suspense 外层:fallback 期与面板期 context 一致,懒加载首帧也取得到。 */}
      <PanelHostProvider value={host}>
        {/* 空态自动收起:keyed 子组件跑当前面板的 usePresence（Hook 序列恒定,见 PresenceGuard）。 */}
        {desc.usePresence ? (
          <PresenceGuard key={desc.id} usePresence={desc.usePresence} onAbsent={close} />
        ) : null}
        <Suspense fallback={null}>
          <Body />
        </Suspense>
      </PanelHostProvider>
    </aside>
  );
}
