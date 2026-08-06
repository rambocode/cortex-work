// 桌面宠物本体 —— 纯展示 + 拖拽,不含任何状态机逻辑。
//
// 姿态(data-state)来自 usePetStore,由 core/pet 的状态机写入(桌面端在主窗口的
// PetBridge 里跑,overlay 只是镜像);设置的恢复也在 PetBridge。本组件只负责:
// 定位/拖拽、悬停 3D 视差、✕ 隐藏、以及把「被点了一下」报回去。
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
import { loadPetPrefs, patchPetPrefs } from "./prefs";

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

// 独立 pet-overlay 窗口的固定尺寸(windowFollowsPet 模式下把宠物居中定位在这个尺寸里)。
// 必须与 apps/desktop/src/main/pet-overlay-window.ts 里的同名常量保持一致——那边是
// 窗口的真实像素尺寸,这边只是拿来算居中偏移,两处对不上宠物会在窗口里显示偏移。
const OVERLAY_WINDOW_W = 260;
const OVERLAY_WINDOW_H = 240;

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
}

export function Pet({ windowFollowsPet = false, onEnabledChange, onPoke }: PetProps = {}) {
  const { t } = useTranslation("pet");
  const state = usePetStore((s) => s.state);
  const sprite = usePetStore((s) => s.sprite);
  const enabled = usePetStore((s) => s.enabled);
  const size = usePetStore((s) => s.size);

  const petW = PET_W * size;
  // 实际高度由 sprite 的格子宽高比决定(内置 110:100、petdex 192:208 不同),
  // 由 PetCanvas 回报——拖拽夹取与窗口内居中都要用它,不能写死。
  const [petH, setPetH] = useState(Math.round((PET_W * 100) / 110) * size);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [tilt, setTilt] = useState<{ rx: number; ry: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const onCanvasSize = useCallback((s: { width: number; height: number }) => setPetH(s.height), []);

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
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top, moved: false };
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

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
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
    // 逗一下宠物。两种形态走不同通道:
    // - 内嵌(Web):置一次性的庆祝位,由状态机派生成 happy 并自动清除。
    // - overlay:状态机不在这个窗口跑(它是纯镜像),写 store 会被下一次同步顶回去,
    //   故交给宿主做本地显示覆写(见 pet-overlay.tsx)。
    if (windowFollowsPet) onPoke?.();
    else petActivity.flash("celebrate");
  };

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
  const dragRegionStyle = windowFollowsPet ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
  const noDragRegionStyle = windowFollowsPet ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

  return (
    <div
      ref={rootRef}
      className={`pet ${dragRef.current?.moved ? "is-dragging" : ""}`}
      data-state={state}
      title={stateLabel}
      style={{ width: petW, height: petH, ...posStyle, ...dragRegionStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setTilt(null)}
    >
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
      <div
        className="pet-3d"
        style={tilt ? { transform: `rotateX(${tilt.rx.toFixed(1)}deg) rotateY(${tilt.ry.toFixed(1)}deg)` } : undefined}
      >
        <PetCanvas sprite={sprite} state={state} width={petW} onSize={onCanvasSize} />
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
