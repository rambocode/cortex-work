// designUi 分片的 BrowserStorageLike 适配器：design 树的画布 UI 态(视口记忆/
// 折叠态等)原走 localStorage,cortex 侧改存 PersistedState.designUi——
// 读写同步走 usePersonalStore 内存态,落盘由个人工作区既有的节流 saveState 兜底。
import { usePersonalStore } from "../../store/personal";
import type { BrowserStorageLike } from "../compat/browser-storage";

export const designUiStorage: BrowserStorageLike = {
  getItem: (key) => usePersonalStore.getState().designUi[key] ?? null,
  setItem: (key, value) => usePersonalStore.getState().setDesignUiItem(key, value),
  removeItem: (key) => usePersonalStore.getState().setDesignUiItem(key, null),
};
