// 桌面宠物 —— 纯 SVG + CSS 动画,浮层全局可拖动,随应用状态切换形态:
//   idle      呼吸/眨眼/甩尾/耳朵偶尔抖
//   typing    耳朵竖起,瞳孔盯向左下输入框,尾巴加速
//   thinking  仰头盯思考泡泡「…」
//   working   眯眼专注,齿轮旋转,前爪敲击,冒汗
//   replying  弯月笑眼,嘴巴开合,对话气泡
//   sleeping  闭眼耷耳,Zzz 飘浮
//   happy     跳一下 + 爱心(点击/任务完成)
// 造型在设置菜单中选择(pet/designs.tsx);衰减转换由本组件节拍器驱动;
// 可拖动(位置存 localStorage);悬停时跟随光标做 3D 视差倾斜。

import { useEffect, useRef, useState } from "react";
import { usePetStore } from "@cortex-work/core";
import { PET_DESIGNS, loadPetColor, loadPetKind, loadPetSize, petColorVars } from "./designs";

const STATE_LABEL: Record<string, (name: string) => string> = {
  idle: (n) => `${n}在待命`,
  typing: (n) => `${n}在看你打字`,
  thinking: (n) => `${n}在思考…`,
  working: (n) => `${n}在埋头干活`,
  replying: (n) => `${n}在回话`,
  sleeping: (n) => `${n}睡着了,点我叫醒`,
  happy: (n) => `${n}很开心!`,
};

const POS_KEY = "cortex_pet_pos";
const PET_W = 110;
const PET_H = 100;

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
  const state = usePetStore((s) => s.state);
  const kind = usePetStore((s) => s.kind);
  const size = usePetStore((s) => s.size);
  const color = usePetStore((s) => s.color);
  const set = usePetStore((s) => s.set);
  const setKind = usePetStore((s) => s.setKind);
  const setSize = usePetStore((s) => s.setSize);
  const setColor = usePetStore((s) => s.setColor);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => loadPos(loadPetSize()));
  const [tilt, setTilt] = useState<{ rx: number; ry: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; moved: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // 启动时恢复上次选择的造型 / 尺寸 / 配色。
  useEffect(() => {
    setKind(loadPetKind());
    setSize(loadPetSize());
    setColor(loadPetColor());
  }, [setKind, setSize, setColor]);

  // 节拍器:处理超时衰减。
  useEffect(() => {
    const timer = setInterval(() => {
      const { state: cur, lastActivity } = usePetStore.getState();
      const quiet = Date.now() - lastActivity;
      if (cur === "typing" && quiet > 1600) set("idle");
      else if (cur === "happy" && quiet > 2200) set("idle");
      else if (cur === "idle" && quiet > 120_000) set("sleeping");
    }, 500);
    return () => clearInterval(timer);
  }, [set]);

  // 拖动(pointer capture;移动超过阈值视为拖,否则当点击)。
  const onPointerDown = (e: React.PointerEvent) => {
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

  // 窗口缩放或宠物尺寸变化时夹回可视区。
  useEffect(() => {
    const onResize = () => setPos((p) => (p ? clampPos(p, size) : p));
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [size]);

  const design = PET_DESIGNS[kind];
  const Parts = design.Parts;
  // 自定义配色变量(未自定义时为空,SVG 回落到造型默认色);--pet-scale 供阴影等 CSS 跟随。
  const styleVars = {
    "--pet-scale": size,
    ...(color ? petColorVars(color) : null),
  } as React.CSSProperties;

  return (
    <div
      ref={rootRef}
      className={`pet ${dragRef.current?.moved ? "is-dragging" : ""}`}
      data-state={state}
      title={STATE_LABEL[state]?.(design.name)}
      style={{ ...styleVars, ...(pos ? { left: pos.x, top: pos.y, right: "auto", bottom: "auto" } : null) }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setTilt(null)}
    >
      <div
        className="pet-3d"
        style={tilt ? { transform: `rotateX(${tilt.rx.toFixed(1)}deg) rotateY(${tilt.ry.toFixed(1)}deg)` } : undefined}
      >
        <svg viewBox="0 0 140 120" width={Math.round(104 * size)} height={Math.round(89 * size)} aria-hidden="true">
          <Parts />
        </svg>
        <div className="pet-shadow" />
      </div>
    </div>
  );
}
