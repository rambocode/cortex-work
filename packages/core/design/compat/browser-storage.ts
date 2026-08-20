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

// 品牌改名前(Kun)写下的键前缀。读到旧键时顺手迁移到新键，
// 避免升级后用户的画布视图/视口/助手模型等 UI 偏好被清零。
const LEGACY_KEY_PREFIX = "kun.";
const CURRENT_KEY_PREFIX = "cortex.";

// 把新键映射回旧品牌键（cortex.x → kun.x）；非 cortex. 前缀返回 null 表示无旧键。
export function legacyBrandStorageKey(key: string): string | null {
  if (!key.startsWith(CURRENT_KEY_PREFIX)) return null;
  return `${LEGACY_KEY_PREFIX}${key.slice(CURRENT_KEY_PREFIX.length)}`;
}

/**
 * 通用「读新键，回退旧品牌键并就地迁移」读取器。
 * 直接持有 storage 句柄（registry / localStorage 等）的调用点复用它，
 * 避免每处各写一遍回退分支而漏掉某个键。
 */
export function readWithLegacyBrandKey(
  key: string,
  getItem: (key: string) => string | null,
  setItem?: (key: string, value: string) => void
): string | null {
  const current = getItem(key);
  if (current !== null) return current;
  const legacyKey = legacyBrandStorageKey(key);
  if (!legacyKey) return null;
  const legacy = getItem(legacyKey);
  if (legacy !== null) setItem?.(key, legacy);
  return legacy;
}

export function readBrowserStorageItem(key: string): string | null {
  try {
    const storage = browserStorage();
    const current = storage?.getItem(key) ?? null;
    if (current !== null || !key.startsWith(CURRENT_KEY_PREFIX)) return current;
    const legacyKey = `${LEGACY_KEY_PREFIX}${key.slice(CURRENT_KEY_PREFIX.length)}`;
    const legacy = storage?.getItem(legacyKey) ?? null;
    if (legacy !== null) storage?.setItem(key, legacy);
    return legacy;
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
