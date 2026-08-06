// 桌面宠物本体 —— 纯展示 + 拖拽,不含任何状态机逻辑。
//
// 姿态(data-state)来自 usePetStore,由 core/pet 的状态机写入(桌面端在主窗口的
// PetBridge 里跑,overlay 只是镜像);设置的恢复也在 PetBridge。本组件只负责:
// 定位/拖拽、悬停 3D 视差、右下角缩放手柄、✕ 隐藏、以及把「被点了一下」报回去。
//
// 姿态一览:idle 待命 / typing 看你打字 / thinking 思考 / working 埋头干活 /
// replying 回话 / waiting 等你确认 / sleeping 打盹 / happy 开心 / failed 出错了。
// 逐帧渲染在 PetCanvas;造型(内置角色 or petdex 图鉴)在设置菜单中选择。

import { useCallback, useEffect, useRef, useState } from "react";
import { usePetStore } from "@cortex-work/core";
import { petActivity } from "@cortex-work/core/pet";
import { useTranslation } from "@cortex-work/core/i18n";
import { PetCanvas } from "./PetCanvas";
import { BUILTIN_NAME } from "./sheets";
import { clampPetSize, loadPetPrefs, patchPetPrefs } from "./prefs";

const PET_STATES = [
  "idle",
  "typing",
  "thinking",
  "working",
  "replying",
  "waiting",
  "sleeping",
  "happy",
  "failed",
] as const;

const POS_KEY = "cortex_pet_pos";
/** 宠物在 scale=1 时的设计宽度。高度按 sprite 的格子宽高比推算,故随来源变化。 */
const PET_W = 110;

/** 状态气泡在一次姿态变化后的可见时长(毫秒)。到点淡出,不常驻遮挡桌面。 */
const TIP_MS = 3200;

/** 键盘方向键 / 滚轮每一步的缩放幅度。 */
const SIZE_STEP = 0.05;

/** 滚轮停手多久后落盘一次(一次滚动会打出几十个事件,不防抖等于疯狂写盘)。 */
const WHEEL_COMMIT_MS = 260;

/** overlay 悬停命中框相对宠物盒子的外扩像素(✕ 与缩放手柄都溢出盒子 2px)。 */
const HOVER_PAD = 8;

// 独立 pet-overlay 窗口的固定尺寸(windowFollowsPet 模式下把宠物居中定位在这个尺寸里)。
// 必须与 apps/desktop/src/main/pet-overlay-window.ts 里的同名常量保持一致——那边是
// 窗口的真实像素尺寸,这边只是拿来算居中偏移,两处对不上宠物会在窗口里显示偏移。
// 高度比最大只宠物(petdex size=2 时 220×238)多出的部分是留给上方 .pet-tip 状态气泡的:
// 窗口 transparent,这块留白不可见,但少了它气泡会被窗口边界裁掉。
const OVERLAY_WINDOW_W = 260;
const OVERLAY_WINDOW_H = 304;

function clampPos(p: { x: number; y: number }, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(0, p.x), window.innerWidth - w),
    y: Math.min(Math.max(0, p.y), window.innerHeight - h),
  };
}

function loadPos(w: number, h: number): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === "number" && typeof p?.y === "number") return clampPos(p, w, h);
  } catch {
    /* 忽略 */
  }
  return null;
}

export interface PetProps {
  /** 独立 pet-overlay 窗口专用:true 时宠物固定居中在一个刚好包住它的小窗口里,
   * 不做 CSS position:fixed 拖拽定位——挪动宠物改用 `-webkit-app-region: drag` 让
   * 操作系统直接移动这扇窗口本身(见 pet-overlay-window.ts 头部注释——多显示器下,
   * 靠 CSS 在一个铺满全屏的透明窗口内挪动会被 macOS 裁剪,原生窗口拖拽不受此限)。
   * 主窗口内嵌场景(Web)不传。 */
  windowFollowsPet?: boolean;
  /** 独立 overlay 把显隐动作回传给主窗口设置真源；主窗口内嵌模式无需传。 */
  onEnabledChange?: (enabled: boolean) => void;
  /** 点击宠物(非拖拽)。仅 windowFollowsPet 模式需要:那个窗口里没有状态机,
   * 由宿主做本地显示覆写。内嵌模式不传,组件自己置庆祝位。 */
  onPoke?: () => void;
  /** 缩放手柄拖完后的最终尺寸。同 onEnabledChange:overlay 的 localStorage 与主窗口
   * 不同源,落盘只能由主窗口做,故独立 overlay 模式必须传,内嵌模式不传(组件自己落盘)。 */
  onSizeChange?: (size: number) => void;
  /** 仅 windowFollowsPet 模式:主进程轮询推来的光标位置(窗口内 CSS 坐标,null=不在窗口内)。
   * 这扇窗口是 focusable:false 的 panel 且整块 app-region:drag,拿不到任何鼠标移动事件,
   * :hover / pointerEnter 永远不触发(实测:必须右键点一下 ✕ 和手柄才冒出来),悬停态只能
   * 靠它算(详见 apps/desktop/src/main/pet-overlay-window.ts 的注释)。 */
  externalCursor?: { x: number; y: number } | null;
  /** 仅 windowFollowsPet 模式:主进程观察到的窗口移动方向(null=没在动)。原生 app-region
   * 拖拽全程不经渲染进程,拖动方向只有主进程看得见(它监听窗口自己的 moved 事件)。 */
  externalMoveDir?: "left" | "right" | null;
}

export function Pet({
  windowFollowsPet = false,
  onEnabledChange,
  onPoke,
  onSizeChange,
  externalCursor,
  externalMoveDir,
}: PetProps = {}) {
  const { t } = useTranslation("pet");
  const state = usePetStore((s) => s.state);
  const sprite = usePetStore((s) => s.sprite);
  const enabled = usePetStore((s) => s.enabled);
  const size = usePetStore((s) => s.size);

  // 缩放手柄拖拽期间的本地尺寸草稿。为什么不直接写 store:overlay 是纯镜像,主窗口每次
  // 状态广播都会覆盖 size,拖到一半被顶回去会抖;草稿优先于 store,松手才提交。
  const [sizeDraft, setSizeDraft] = useState<number | null>(null);
  const effSize = sizeDraft ?? size;

  const petW = PET_W * effSize;
  // 实际高度由 sprite 的格子宽高比决定(内置 110:100、petdex 192:208 不同),
  // 由 PetCanvas 回报——拖拽夹取与窗口内居中都要用它,不能写死。
  const [petH, setPetH] = useState(Math.round((PET_W * 100) / 110) * size);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [tilt, setTilt] = useState<{ rx: number; ry: number } | null>(null);
  // 气泡的两个独立显示来源:姿态刚变过(自动淡出)/ 鼠标正悬停(常显)。
  const [tipFlash, setTipFlash] = useState(false);
  const [hovered, setHovered] = useState(false);
  // 内嵌模式下被拖着走的方向(overlay 走 externalMoveDir);非空时改播奔跑帧。
  const [dragDir, setDragDir] = useState<"left" | "right" | null>(null);
  // 双击时递增,让 PetCanvas 把当前动作从第 0 帧重播一遍。
  const [replayToken, setReplayToken] = useState(0);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    /** 上一帧的横坐标,用来判断这一小步是往左还是往右(方向要能中途翻转)。 */
    lastX: number;
    moved: boolean;
  } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; startW: number } | null>(null);
  // 滚轮缩放的草稿镜像:wheel 事件比重渲染密集,直接读 sizeDraft 会拿到上一帧的值。
  const sizeDraftRef = useRef<number | null>(null);
  const wheelCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  /** 草稿的唯一写入口:state 用于渲染,ref 供高频事件读回最新值。 */
  const putSizeDraft = useCallback((next: number | null) => {
    sizeDraftRef.current = next;
    setSizeDraft(next);
  }, []);

  const moveDir = windowFollowsPet ? (externalMoveDir ?? null) : dragDir;

  const onCanvasSize = useCallback((s: { width: number; height: number }) => setPetH(s.height), []);

  // 会话状态一变就主动冒一次气泡。
  // 为什么不用原生 title:独立 pet-overlay 窗口 focusable:false(鼠标移入不激活窗口)、
  // 尺寸又只有 260×288,Chromium 的 tooltip 要么不触发、要么被窗口边界裁掉,用户实际
  // 看不到任何状态提示;而且 tooltip 要悬停约 1s 才出,表达不了「状态刚刚变了」。
  // 首次挂载不弹:开机就冒一句「在待命」纯属噪音,故用 ref 记住上一个姿态跳过首帧。
  const prevStateRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (prev === null || prev === state) return;
    setTipFlash(true);
    const timer = setTimeout(() => setTipFlash(false), TIP_MS);
    return () => clearTimeout(timer);
  }, [state]);

  // 记忆位置在拿到真实尺寸后才读:夹取需要宽高,提前读会按错误的盒子夹一次。
  useEffect(() => {
    if (windowFollowsPet) return;
    setPos(loadPos(PET_W * loadPetPrefs().size, petH));
    // 仅在挂载时恢复一次;后续的尺寸变化由下面的 resize effect 负责夹回。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowFollowsPet]);

  // 拖动(pointer capture,移动超过阈值视为拖,否则当点击)。
  // windowFollowsPet 模式下整个跳过——挪动窗口交给 `-webkit-app-region: drag` 原生处理,
  // dragRef 永远不会被设置,onPointerUp 里的 `d?.moved` 判断天然落到"当作点击"分支。
  const onPointerDown = (e: React.PointerEvent) => {
    if (windowFollowsPet) return;
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: rect.left,
      origY: rect.top,
      lastX: e.clientX,
      moved: false,
    };
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件等无效 pointerId,忽略 */
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (d) {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      if (!d.moved && Math.hypot(dx, dy) > 4) d.moved = true;
      if (d.moved) {
        setTilt(null);
        setPos(clampPos({ x: d.origX + dx, y: d.origY + dy }, petW, petH));
        // 朝哪边拽就播哪边的奔跑帧。用「与上一帧的位移」而非「与起点的位移」,
        // 否则往回拖时方向不会翻转(总位移的符号还没变过来)。
        const stepX = e.clientX - d.lastX;
        if (Math.abs(stepX) >= 1) setDragDir(stepX > 0 ? "right" : "left");
        d.lastX = e.clientX;
      }
      return;
    }
    // 未拖动时:光标视差倾斜(伪 3D)。
    const el = rootRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({ rx: -ny * 14, ry: nx * 16 });
  };

  /**
   * 逗一下宠物(单击 / 双击)。除了置庆祝位,还让当前动作从第 0 帧重播——双击时姿态
   * 多半已经是 happy,不重播的话第二下完全看不出反应。
   * 两种形态走不同通道:
   * - 内嵌(Web):置一次性的庆祝位,由状态机派生成 happy 并自动清除。
   * - overlay:状态机不在这个窗口跑(它是纯镜像),写 store 会被下一次广播顶回去,
   *   故交给宿主做本地显示覆写(见 pet-overlay.tsx)。
   */
  const poke = () => {
    setReplayToken((n) => n + 1);
    if (windowFollowsPet) onPoke?.();
    else petActivity.flash("celebrate");
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragDir(null); // 松手就停下来,别让宠物原地跑
    try {
      rootRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    if (d?.moved) {
      // 用事件坐标重算终点（不读 rect:React 可能尚未重渲,会拿到旧位置）。
      const final = clampPos({ x: d.origX + (e.clientX - d.startX), y: d.origY + (e.clientY - d.startY) }, petW, petH);
      setPos(final);
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(final));
      } catch {
        /* 忽略 */
      }
      return; // 拖动结束不触发点击
    }
    poke();
  };

  // ── 右下角缩放手柄 ───────────────────────────────────────────────────────────
  // 尺寸设置从设置页搬到宠物本体上:所见即所得地拖,不用来回开设置弹窗对照大小。

  /** 提交最终尺寸。两种形态的落盘通道不同,见 onSizeChange 的注释。 */
  const commitSize = (next: number) => {
    if (windowFollowsPet) {
      // 乐观本地生效,避免松手到主窗口回写广播回来之间闪回旧尺寸。
      usePetStore.getState().setSize(next);
      onSizeChange?.(next);
    } else {
      patchPetPrefs({ size: next });
    }
  };

  /** 把手柄位移换算成尺寸。宠物按格子比例等比缩放,故只取右下对角方向的等效位移。 */
  const sizeFromDelta = (startW: number, dx: number, dy: number): number => {
    // windowFollowsPet 下宠物固定居中在窗口里:宽度每增加 Δ,右下角只往外走 Δ/2,
    // 位移要乘 2 手柄才跟得住光标。内嵌模式用 left/top 定位,右下角位移即宽度增量。
    const gain = windowFollowsPet ? 2 : 1;
    return clampPetSize((startW + ((dx + dy) / 2) * gain) / PET_W);
  };

  const onResizeDown = (e: React.PointerEvent) => {
    e.stopPropagation(); // 别让本体把它当成拖动/点击手势的起点
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: petW };
    putSizeDraft(effSize);
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 合成事件等无效 pointerId,忽略 */
    }
  };

  const onResizeMove = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    e.stopPropagation(); // 拖手柄时不要触发本体的视差倾斜
    putSizeDraft(sizeFromDelta(r.startW, e.clientX - r.startX, e.clientY - r.startY));
  };

  const onResizeUp = (e: React.PointerEvent) => {
    const r = resizeRef.current;
    resizeRef.current = null;
    e.stopPropagation(); // 松手不能冒泡成「逗了一下宠物」
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    if (!r) return;
    // 用事件坐标重算终值(不读 sizeDraft:React 可能尚未重渲,会拿到上一帧的值)。
    const final = sizeFromDelta(r.startW, e.clientX - r.startX, e.clientY - r.startY);
    putSizeDraft(null);
    commitSize(final);
  };

  /**
   * 滚轮缩放(参考实现同款手感:在宠物身上滚一下就变大变小)。
   * 落盘防抖:一次滚动会打出几十个 wheel 事件,每个都提交等于疯狂写盘 / 发 IPC。
   * 期间只更新草稿(即时预览),停手 WHEEL_COMMIT_MS 后提交一次。
   */
  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY === 0) return;
    const base = sizeDraftRef.current ?? size;
    const next = clampPetSize(base + (e.deltaY < 0 ? SIZE_STEP : -SIZE_STEP));
    putSizeDraft(next);
    if (wheelCommitRef.current) clearTimeout(wheelCommitRef.current);
    wheelCommitRef.current = setTimeout(() => {
      wheelCommitRef.current = null;
      putSizeDraft(null);
      commitSize(next);
    }, WHEEL_COMMIT_MS);
  };

  // 卸载时别把待提交的滚轮结果丢在定时器里(overlay 关闭 / 切造型都会走这条路)。
  useEffect(() => () => {
    if (wheelCommitRef.current) clearTimeout(wheelCommitRef.current);
  }, []);

  /** 方向键微调:手柄是可聚焦按钮,不给键盘通道等于把缩放做成纯鼠标特性。 */
  const onResizeKeyDown = (e: React.KeyboardEvent) => {
    const up = e.key === "ArrowUp" || e.key === "ArrowRight";
    const down = e.key === "ArrowDown" || e.key === "ArrowLeft";
    if (!up && !down) return;
    const step = up ? SIZE_STEP : -SIZE_STEP;
    e.preventDefault();
    e.stopPropagation();
    commitSize(clampPetSize(effSize + step));
  };

  // overlay 模式的悬停 / 缩放都吃主进程推来的光标坐标(见 externalCursor 的注释)。
  // 命中框按宠物盒子外扩 HOVER_PAD:✕ 与缩放手柄都溢出盒子 2px,严格按盒子判会在光标够到
  // 它们之前就收起来,变成「看得见点不着」。
  useEffect(() => {
    if (!windowFollowsPet) return;
    if (!externalCursor) {
      setHovered(false);
      return;
    }
    // 拖手柄期间这份坐标兼作缩放输入:overlay 里 pointermove 能否送达取决于 macOS 对
    // 非激活窗口的拖拽事件派发,轮询坐标是更可靠的那一路(两者算出的值一致,重复设无副作用)。
    const r = resizeRef.current;
    if (r) {
      putSizeDraft(sizeFromDelta(r.startW, externalCursor.x - r.startX, externalCursor.y - r.startY));
      return;
    }
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setHovered(
      externalCursor.x >= rect.left - HOVER_PAD &&
        externalCursor.x <= rect.right + HOVER_PAD &&
        externalCursor.y >= rect.top - HOVER_PAD &&
        externalCursor.y <= rect.bottom + HOVER_PAD,
    );
    // sizeFromDelta 每次渲染都是新函数,列进依赖只会让 effect 空转;它只读 props 与入参,
    // 用当前渲染的那一份就是对的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowFollowsPet, externalCursor]);

  // 窗口缩放或宠物尺寸变化时夹回可视区。
  useEffect(() => {
    if (windowFollowsPet) return;
    const onResize = () => setPos((p) => (p ? clampPos(p, petW, petH) : p));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [windowFollowsPet, petW, petH]);

  const hide = () => {
    patchPetPrefs({ enabled: false }); // 单一端口:改 store 与落盘由它一并完成
    onEnabledChange?.(false);
  };

  if (!enabled) return null;

  const petName = sprite?.displayName || BUILTIN_NAME;
  const stateLabel = (PET_STATES as readonly string[]).includes(state)
    ? t(`state.${state}`, { name: petName })
    : undefined;
  const tipOpen = Boolean(stateLabel) && (tipFlash || hovered);

  // 定位:windowFollowsPet 模式下固定居中在 overlay 窗口里(挪动窗口本身,不挪 CSS);
  // 其余情况用记忆位置(无则 CSS 默认右下)。
  const posStyle = windowFollowsPet
    ? {
        left: (OVERLAY_WINDOW_W - petW) / 2,
        top: (OVERLAY_WINDOW_H - petH) / 2,
        right: "auto" as const,
        bottom: "auto" as const,
      }
    : pos
      ? { left: pos.x, top: pos.y, right: "auto" as const, bottom: "auto" as const }
      : null;
  // 原生窗口拖拽区域(仅 windowFollowsPet 模式):关闭按钮要单独标 no-drag,否则点它会
  // 被当成拖拽手势的一部分,点不到。
  // is-window-pet 让 CSS 认出 overlay 形态,把 :hover 那套规则整体让位给 is-hovered。
  // 必须互斥而不是并存:overlay 收不到鼠标移动事件(见 externalCursor),Chromium 的
  // :hover 会**卡在上一次命中测试的元素上**——按一下让它命中后,鼠标移开也不会撤销,
  // 手柄就此赖着不走。这是"移开不隐藏"的真正原因,不是 is-hovered 没算对。
  const rootClass = [
    "pet",
    windowFollowsPet ? "is-window-pet" : "",
    dragRef.current?.moved ? "is-dragging" : "",
    sizeDraft !== null ? "is-resizing" : "",
    hovered ? "is-hovered" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const dragRegionStyle = windowFollowsPet ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
  const noDragRegionStyle = windowFollowsPet ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

  return (
    <div
      ref={rootRef}
      className={rootClass}
      data-state={state}
      style={{ width: petW, height: petH, ...posStyle, ...dragRegionStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={poke}
      // overlay 形态下悬停只认 externalCursor 一个来源:这两个事件在那扇窗口里只会在
      // 「按下」时偶发触发一次(移动事件收不到),留着只会和轮询结果打架。
      onPointerEnter={() => {
        if (!windowFollowsPet) setHovered(true);
      }}
      onPointerLeave={() => {
        setTilt(null);
        if (!windowFollowsPet) setHovered(false);
      }}
    >
      {/* 状态气泡。role=status + aria-live 顶替了原先 title 提供的无障碍名;
          常驻在 DOM 里(靠 class 切换显隐)而不是条件渲染,否则每次都是新节点、
          CSS 过渡不会播,气泡会硬闪。 */}
      {stateLabel ? (
        <div className={`pet-tip ${tipOpen ? "is-open" : ""}`} role="status" aria-live="polite">
          {stateLabel}
        </div>
      ) : null}
      <button
        className="pet-x"
        title={t("hideTitle")}
        aria-label={t("hideAria")}
        style={noDragRegionStyle}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          hide();
        }}
      >
        ×
      </button>
      {/* 缩放手柄。悬停才浮现(拖拽期间靠 .is-resizing 保持可见——指针捕获后光标常常
          已经移出宠物盒子,只靠 :hover 会中途消失)。overlay 模式必须标 no-drag,
          否则整块手柄被原生窗口拖拽吃掉,按下去只会挪窗口。 */}
      <button
        className="pet-resize"
        type="button"
        title={t("resizeTitle")}
        aria-label={t("resizeAria")}
        style={noDragRegionStyle}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        onPointerCancel={onResizeUp}
        onKeyDown={onResizeKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 双向对角箭头(↖↘),取自参考实现 hermes-studio 的 icons/pet-resize.svg,
            改用 currentColor 以便跟随主题。 */}
        <svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
          <path
            d="M0 113.810286V0h455.094857v113.810286H194.194286L482.742857 402.285714 402.285714 482.742857 113.810286 194.194286v260.900571H0V113.810286zM1024 910.189714V1024H568.905143v-113.810286h260.900571L541.257143 621.714286l80.457143-80.457143 288.475428 288.548571V568.905143H1024v341.284571z"
            fill="currentColor"
          />
        </svg>
      </button>
      <div
        className="pet-3d"
        style={tilt ? { transform: `rotateX(${tilt.rx.toFixed(1)}deg) rotateY(${tilt.ry.toFixed(1)}deg)` } : undefined}
      >
        <PetCanvas
          sprite={sprite}
          state={state}
          width={petW}
          moveDir={moveDir}
          replayToken={replayToken}
          onSize={onCanvasSize}
        />
        {/* petdex 的 sheet 里没有睡眠动作,idle 行放慢只能表达「安静」,还差一点
            「睡着了」的语义。这是唯一保留的 DOM 配件,其余状态语义都由 sprite 自己承载。 */}
        <span className="pet-zzz" aria-hidden="true">
          <span className="z z1">Z</span>
          <span className="z z2">Z</span>
          <span className="z z3">Z</span>
        </span>
      </div>
    </div>
  );
}
