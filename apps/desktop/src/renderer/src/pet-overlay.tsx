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
import ReactDOM from "react-dom/client";
import { usePetStore } from "@cortex-work/core";
import { Pet } from "@cortex-work/views/cortex-desktop";
import "./pet-overlay.css";

const bridge = window.desktopAPI?.personal;

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
    usePetStore.setState(snapshot);
  });
  bridge.requestPetSync?.();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <Pet windowFollowsPet onEnabledChange={(enabled) => bridge?.setPetEnabled?.(enabled)} />,
);
