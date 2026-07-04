// Kun lib/browser-storage 的注入式版本：core 禁用 localStorage，
// 默认落到进程内 Map（会话内有效）；宿主可经 setDesignStorage() 注入
// 持久化实现（cortex 侧为 PersistedState.designUi 分片适配，批2 接线）。
// 导出 API 与 Kun 完全一致，移植代码零改动。
export type BrowserStorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem?: (key: string) => void;
};

// 默认内存实现：未注入持久化后端时保证功能可用（仅当前会话）。
const memory = new Map<string, string>();
const memoryStorage: BrowserStorageLike = {
  getItem: (key) => (memory.has(key) ? (memory.get(key) as string) : null),
  setItem: (key, value) => {
    memory.set(key, value);
  },
  removeItem: (key) => {
    memory.delete(key);
  },
};

let installed: BrowserStorageLike | null = null;

// 宿主注入持久化后端（如 designUi 分片）；传 null 恢复内存实现。
export function setDesignStorage(storage: BrowserStorageLike | null): void {
  installed = storage;
}

export function browserStorage(): BrowserStorageLike | null {
  return installed ?? memoryStorage;
}

export function readBrowserStorageItem(key: string): string | null {
  try {
    return browserStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeBrowserStorageItem(key: string, value: string): void {
  try {
    browserStorage()?.setItem(key, value);
  } catch {
    /* 持久化失败静默忽略（与 Kun 语义一致） */
  }
}

export function removeBrowserStorageItem(key: string): void {
  try {
    browserStorage()?.removeItem?.(key);
  } catch {
    /* 持久化失败静默忽略 */
  }
}
