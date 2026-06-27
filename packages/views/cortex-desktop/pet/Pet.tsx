// 桌面宠物 —— 纯 SVG + CSS 动画,随应用状态切换形态:
//   idle      呼吸/眨眼/甩尾/耳朵偶尔抖
//   typing    耳朵竖起,瞳孔盯向左下输入框,尾巴加速
//   thinking  仰头盯思考泡泡「…」
//   working   眯眼专注,齿轮旋转,前爪敲击,冒汗
//   replying  弯月笑眼,嘴巴开合,对话气泡
//   sleeping  闭眼耷耳,Zzz 飘浮
//   happy     跳一下 + 爱心(点击/任务完成)
// 行为模式(设置页选择,pet/behavior.ts 持久化):
//   free   自由放置:可拖动(位置存 localStorage),悬停 3D 视差倾斜。
//          叠加「闲时底部走动」开关(walk):开启后宠物常驻底部巡逻道——
//          安静满 10 分钟开始沿底边来回散步(rAF 直改 style,不经 React 重渲),
//          一有事件(输入/思考/点击)平滑过渡回最右侧,原地播放状态动画。
//   perch  趴在聊天输入框上沿:专属趴姿造型,找不到输入框回退右下角
// 悬停浮现 ✕ 可隐藏宠物(设置页可重新打开);造型在设置菜单中选择(pet/designs.tsx)。

import { useEffect, useRef, useState } from "react";
import { usePetStore } from "@cortex-work/core";
import { useTranslation } from "@cortex-work/core/i18n";
import { PERCH_EDGE_Y, PET_DESIGNS, loadPetColor, loadPetKind, loadPetSize, petColorVars } from "./designs";
import { hasSprites } from "./sprites";
import { SpriteLayer } from "./SpriteLayer";
import {
  WALK_IDLE_DELAY_MS,
  loadPetEnabled,
  loadPetMode,
  loadPetWalk,
  savePetEnabled,
  stepWalk,
  type WalkPos,
} from "./behavior";

const PET_STATES = ["idle", "typing", "thinking", "working", "replying", "sleeping", "happy"] as const;

const POS_KEY = "cortex_pet_pos";
const PET_W = 110;
const PET_H = 100;
const SVG_W = 104;
const SVG_H = 89;
// perch 专属造型(designs.tsx 的 Perch):viewBox 140x102,框沿基线在 PERCH_EDGE_Y,
// 头部中心约 x=60;显示比例与全身图一致(SVG_W/140)。
const PERCH_VIEW_H = 102;
const PERCH_SCALE = SVG_W / 140;

function loadPos(size: number): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (typeof p?.x === "number" && typeof p?.y === "number") return clampPos(p, size);
  } catch {
    /* 忽略 */
  }
  return null;
}

function clampPos(p: { x: number; y: number }, size: number): { x: number; y: number } {
  return {
    x: Math.min(Math.max(0, p.x), window.innerWidth - PET_W * size),
    y: Math.min(Math.max(0, p.y), window.innerHeight - PET_H * size),
  };
}

export function Pet() {
  const { t } = useTranslation("pet");
  const state = usePetStore((s) => s.state);
  const kind = usePetStore((s) => s.kind);
  const mode = usePetStore((s) => s.mode);
  const walk = usePetStore((s) => s.walk);
  const enabled = usePetStore((s) => s.enabled);
  const size = usePetStore((s) => s.size);
  const color = usePetStore((s) => s.color);
  const set = usePetStore((s) => s.set);
  const wake = usePetStore((s) => s.wake);
  const setKind = usePetStore((s) => s.setKind);
  const setMode = usePetStore((s) => s.setMode);
  const setWalk = usePetStore((s) => s.setWalk);
  const setEnabled = usePetStore((s) => s.setEnabled);
  const setSize = usePetStore((s) => s.setSize);
  const setColor = usePetStore((s) => s.setColor);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => loadPos(loadPetSize()));
  const [tilt, setTilt] = useState<{ rx: number; ry: number } | null>(null);
  // 安静满 10 分钟(WALK_IDLE_DELAY_MS)→ 无聊,可以开始散步;由节拍器驱动。
  const [bored, setBored] = useState(false);
  // perch 模式锚定位置;null = 没找到输入框(回退默认右下角全身造型)。
  const [perch, setPerch] = useState<{ left: number; top: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  const walkRef = useRef<WalkPos>({
    x: typeof window !== "undefined" ? Math.max(0, window.innerWidth - PET_W - 18) : 0,
    dir: -1,
  });
  const rootRef = useRef<HTMLDivElement>(null);

  // 启动时恢复上次选择的造型 / 行为 / 显隐 / 尺寸 / 配色。
  useEffect(() => {
    setKind(loadPetKind());
    setMode(loadPetMode());
    setWalk(loadPetWalk());
    setEnabled(loadPetEnabled());
    setSize(loadPetSize());
    setColor(loadPetColor());
  }, [setKind, setMode, setWalk, setEnabled, setSize, setColor]);

  // 节拍器:超时衰减 + 无聊判定。
  // 安静 2–10 分钟打盹;满 10 分钟且开了走动开关 → 叫醒去散步(wake 不刷新
  // lastActivity,否则一醒计时清零就永远走不起来)。
  useEffect(() => {
    const timer = setInterval(() => {
      const { state: cur, lastActivity, mode: m, walk: w, enabled: en } = usePetStore.getState();
      const quiet = Date.now() - lastActivity;
      const boredNow = en && w && m === "free" && quiet >= WALK_IDLE_DELAY_MS;
      if (cur === "typing" && quiet > 1600) set("idle");
      else if (cur === "happy" && quiet > 2200) set("idle");
      else if (boredNow && cur === "sleeping") wake();
      else if (cur === "idle" && quiet > 120_000 && !boredNow) set("sleeping");
      setBored(boredNow);
    }, 500);
    return () => clearInterval(timer);
  }, [set, wake]);

  // ---- 底部巡逻道(free + 走动开关):常驻底边,无聊时散步,有事件归位最右 ----
  const lane = enabled && mode === "free" && walk;
  const walking = lane && bored && state === "idle";

  // 进入/退出巡逻道:贴底定位(初始停在最右侧),窗口缩放跟随;退出时清理内联样式。
  useEffect(() => {
    if (!lane) return;
    const el = rootRef.current;
    if (!el) return;
    const place = () => {
      const maxX = Math.max(0, window.innerWidth - PET_W * size);
      walkRef.current = { ...walkRef.current, x: Math.min(Math.max(0, walkRef.current.x), maxX) };
      el.style.left = `${walkRef.current.x}px`;
      el.style.top = `${Math.max(0, window.innerHeight - PET_H * size)}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
    };
    walkRef.current = { x: Math.max(0, window.innerWidth - PET_W * size - 18), dir: -1 };
    place();
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("resize", place);
      el.style.left = el.style.top = el.style.right = el.style.bottom = "";
      delete el.dataset.dir;
    };
  }, [lane, size]);

  // 巡逻道内:走动(rAF 逐帧)↔ 归位(改 left,由 .is-gliding 的 CSS transition 平滑过渡)。
  useEffect(() => {
    if (!lane) return;
    const el = rootRef.current;
    if (!el) return;
    if (!walking) {
      const x = Math.max(0, window.innerWidth - PET_W * size - 18);
      walkRef.current = { x, dir: -1 };
      el.dataset.dir = "right"; // 归位朝右走
      el.style.left = `${x}px`;
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(100, now - last); // 后台节流后的超大 dt 截断,防瞬移
      last = now;
      walkRef.current = stepWalk(walkRef.current, dt, 0, Math.max(0, window.innerWidth - PET_W * size));
      el.style.left = `${walkRef.current.x}px`;
      el.dataset.dir = walkRef.current.dir === 1 ? "right" : "left";
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lane, walking, size]);

  // ---- perch:轮询锚定可见的聊天输入框(.composer-wrap),贴其上沿 ----
  useEffect(() => {
    if (!enabled || mode !== "perch") {
      setPerch(null);
      return;
    }
    const measure = () => {
      const rect = document.querySelector(".composer-wrap")?.getBoundingClientRect();
      if (!rect || rect.width < 80) {
        setPerch(null);
        return;
      }
      // 造型里的框沿基线(PERCH_EDGE_Y)对齐输入框上沿:爪子自然垂搭在框上,
      // 头部(中心 x≈60)水平居中于输入框。
      const left = rect.left + rect.width / 2 - 60 * PERCH_SCALE * size;
      const top = rect.top - PERCH_EDGE_Y * PERCH_SCALE * size;
      setPerch((p) => (p && Math.abs(p.left - left) < 1 && Math.abs(p.top - top) < 1 ? p : { left, top }));
    };
    measure();
    const timer = setInterval(measure, 600);
    window.addEventListener("resize", measure);
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", measure);
    };
  }, [enabled, mode, size]);

  // 拖动(仅 free 且未开走动开关;pointer capture,移动超过阈值视为拖,否则当点击)。
  const onPointerDown = (e: React.PointerEvent) => {
    if (mode !== "free" || lane) return;
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
        setPos(clampPos({ x: d.origX + dx, y: d.origY + dy }, size));
      }
      return;
    }
    // 未拖动时:光标视差倾斜(伪 3D;perch 趴着不倾斜)。
    if (mode === "perch") return;
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
      const final = clampPos({ x: d.origX + (e.clientX - d.startX), y: d.origY + (e.clientY - d.startY) }, size);
      setPos(final);
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(final));
      } catch {
        /* 忽略 */
      }
      return; // 拖动结束不触发点击
    }
    set(state === "happy" ? "idle" : "happy");
  };

  // 窗口缩放或宠物尺寸变化时夹回可视区(free 模式的记忆位置)。
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampPos(p, size) : p));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [size]);

  const hide = () => {
    setEnabled(false);
    savePetEnabled(false);
  };

  if (!enabled) return null;

  const design = PET_DESIGNS[kind];
  const Parts = design.Parts;
  // 宠物名 + 状态提示走 pet 命名空间;PET_DESIGNS.name 仍作为兜底(设置页等仍直读数据)。
  const petName = t(`kind.${kind}.name`, design.name);
  const stateLabel = (PET_STATES as readonly string[]).includes(state)
    ? t(`state.${state}`, { name: petName })
    : undefined;
  // 自定义配色变量(未自定义时为空,SVG 回落到造型默认色);--pet-scale 供阴影等 CSS 跟随。
  const styleVars = {
    "--pet-scale": size,
    ...(color ? petColorVars(color) : null),
  } as React.CSSProperties;

  const perched = mode === "perch" && perch !== null;
  // 定位:巡逻道(lane)由 effect 直改 style;perch 用锚定坐标;
  // 纯 free(未开走动)用记忆位置(无则 CSS 默认右下)。
  const posStyle = lane
    ? null
    : perched
      ? { left: perch.left, top: perch.top, right: "auto" as const, bottom: "auto" as const }
      : mode === "free" && pos
        ? { left: pos.x, top: pos.y, right: "auto" as const, bottom: "auto" as const }
        : null;

  const closeBtn = (
    <button
      className="pet-x"
      title={t("hideTitle")}
      aria-label={t("hideAria")}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        hide();
      }}
    >
      ×
    </button>
  );

  if (perched) {
    const Perch = design.Perch;
    return (
      <div
        ref={rootRef}
        className="pet is-perched"
        data-state={state}
        data-mode="perch"
        title={stateLabel}
        style={{ ...styleVars, ...posStyle }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setTilt(null)}
      >
        {closeBtn}
        <div className="pet-3d">
          <svg
            viewBox={`0 0 140 ${PERCH_VIEW_H}`}
            width={Math.round(SVG_W * size)}
            height={Math.round(PERCH_VIEW_H * PERCH_SCALE * size)}
            aria-hidden="true"
          >
            <Perch />
          </svg>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`pet ${dragRef.current?.moved ? "is-dragging" : ""} ${walking ? "is-walking" : ""} ${lane && !walking ? "is-gliding" : ""}`}
      data-state={state}
      data-mode={mode}
      title={stateLabel}
      style={{ ...styleVars, ...posStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setTilt(null)}
    >
      {closeBtn}
      <div
        className="pet-3d"
        style={tilt ? { transform: `rotateX(${tilt.rx.toFixed(1)}deg) rotateY(${tilt.ry.toFixed(1)}deg)` } : undefined}
      >
        {/* 角色级共存:有 sprite 资产走序列帧渲染层,否则回退现有内联 SVG 造型。
            外围定位/巡逻/拖拽/节拍器与 sprite 层正交,均不受影响。 */}
        {hasSprites(kind) ? (
          <SpriteLayer kind={kind} state={state} walking={walking} />
        ) : (
          <svg viewBox="0 0 140 120" width={Math.round(SVG_W * size)} height={Math.round(SVG_H * size)} aria-hidden="true">
            <Parts />
          </svg>
        )}
      </div>
      <div className="pet-shadow" />
    </div>
  );
}
