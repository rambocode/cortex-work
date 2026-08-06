// 桌面宠物 overlay 窗口 renderer 入口:一扇刚好包住宠物的小透明窗口,只挂载
// <Pet windowFollowsPet/>。裸 ReactDOM.createRoot,不包 CoreProvider(照
// agent-trace.tsx/notes-overlay.tsx 先例——这个窗口没有 workspace/identity 概念,
// usePetStore 是零 context 依赖的纯 zustand store)。
//
// 位置(挪动宠物 = 挪动这扇窗口本身,靠 Pet.tsx 里 `-webkit-app-region: drag` 让 OS
// 原生处理)完全不经这里——主进程监听窗口自身 moved 事件直接持久化,渲染端不需要
// 上报/查询位置(见 apps/desktop/src/main/pet-overlay-window.ts)。
//
// 状态来源:订阅主进程广播的 pet:sync-state(见 PetBridge.tsx → ipc/pet.ts),挂载时
// 先 requestPetSync 要一次当前快照,应对"overlay 先于主窗口 PetBridge 挂载"的时序竞态。
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { usePetStore } from "@cortex-work/core";
import { Pet } from "@cortex-work/views/cortex-desktop";
import "./pet-overlay.css";

const bridge = window.desktopAPI?.personal;

// 本地显示覆写:这扇窗口里没有状态机(它在主窗口的 PetBridge 里跑),点击宠物若直接写
// store,下一次 pet:sync-state 广播就会把它顶回去。故用一个「覆写截止时刻」哨兵:
// 期间照常接收同步快照的其它字段(造型/尺寸/显隐),唯独忽略 state,让 happy 播完。
// 与 core/pet 里 celebrate 一次性位的时长保持一致。
const POKE_MS = 2200;
let overrideUntil = 0;
let overrideTimer: ReturnType<typeof setTimeout> | undefined;

function pokePet(): void {
  overrideUntil = Date.now() + POKE_MS;
  usePetStore.setState({ state: "happy" });
  clearTimeout(overrideTimer);
  // 覆写到期后主动回落——期间被忽略的广播不会自己补发,不落回宠物会一直挂着 happy。
  overrideTimer = setTimeout(() => {
    overrideUntil = 0;
    usePetStore.setState({ state: "idle" });
    bridge?.requestPetSync?.(); // 要一次最新快照,把可能已经变化的真实姿态补回来
  }, POKE_MS);
}

// 这扇窗口是纯展示层,不需要任何右键菜单(默认 Chromium 行为/DevTools 的
// Inspect Element 菜单都会挡在宠物上方、看起来像"宠物窗体自己的菜单")。
window.addEventListener("contextmenu", (e) => e.preventDefault());

if (bridge?.onPetSyncState) {
  // 只在 enabled 变化时通知主进程切换原生窗口。仅让 React 返回 null 不够：透明的
  // BrowserWindow 仍有完整鼠标命中区，会挡住其下方应用。
  let lastEnabled: boolean | undefined;
  usePetStore.subscribe((state) => {
    if (state.enabled === lastEnabled) return;
    lastEnabled = state.enabled;
    bridge.setPetOverlayVisible?.(state.enabled);
  });
  bridge.onPetSyncState((snapshot) => {
    // 本地覆写期间只丢弃 state,其余设置照常同步(此时改造型/尺寸仍要立即生效)。
    if (Date.now() < overrideUntil) {
      const { state: _ignored, ...rest } = snapshot;
      usePetStore.setState(rest);
      return;
    }
    usePetStore.setState(snapshot);
  });
  bridge.requestPetSync?.();
}

/**
 * 只为「悬停」多包的一层。这扇窗口 focusable:false 且整块 app-region:drag,拿不到任何
 * 鼠标移动事件(CSS :hover / pointerEnter 全部失效,实测要右键点一下 ✕ 和缩放手柄才冒
 * 出来),故由主进程轮询光标位置推过来,交给 Pet 自己判断是否落在宠物身上。
 */
function PetOverlayRoot() {
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  // 拖动方向同理:窗口被 OS 搬动,渲染进程连 pointerdown 都收不到,只有主进程看得见。
  const [moveDir, setMoveDir] = useState<"left" | "right" | null>(null);
  useEffect(() => bridge?.onPetOverlayCursor?.(setCursor), []);
  useEffect(() => bridge?.onPetOverlayMoveDir?.(setMoveDir), []);
  return (
    <Pet
      windowFollowsPet
      externalCursor={cursor}
      externalMoveDir={moveDir}
      onEnabledChange={(enabled) => bridge?.setPetEnabled?.(enabled)}
      onSizeChange={(size) => bridge?.setPetSize?.(size)}
      onPoke={pokePet}
    />
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(<PetOverlayRoot />);
