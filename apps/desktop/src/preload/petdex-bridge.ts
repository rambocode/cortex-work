// petdex 公共宠物图鉴的 preload 子桥:把 5 个 petdex:* channel 包成 DesktopBridge["petdex"]。
//
// **必须挂在 personal 下**:views 是经 CoreProvider 注入的 DesktopBridge 拿到它的,
// 而 DesktopBridge 的实现体就是 window.desktopAPI.personal,挂顶层渲染端根本拿不到。
// 单独成文件是因为 preload/index.ts 已 1200+ 行(照 research-bridge.ts 先例)。
//
// 安全约定:这里**只传 slug,不传 URL**。出网目标由主进程从自己缓存的图鉴索引里查,
// 渲染端无法指定任意地址——否则这条桥就成了一个通用的出网通道。

import { ipcRenderer } from "electron";
import type { DesktopBridge } from "@cortex-work/core/desktop/bridge";
import type {
  PetdexCacheStats,
  PetdexManifestResult,
  PetdexSpriteRef,
} from "@cortex-work/core/desktop/petdex-types";

export function createPetdexBridge(): NonNullable<DesktopBridge["petdex"]> {
  return {
    getManifest: (opts?: { force?: boolean }): Promise<PetdexManifestResult> =>
      ipcRenderer.invoke("petdex:manifest", opts),
    ensureSprite: (slug: string): Promise<PetdexSpriteRef> => ipcRenderer.invoke("petdex:ensure-sprite", slug),
    peekSprite: (slug: string): Promise<PetdexSpriteRef | null> => ipcRenderer.invoke("petdex:peek-sprite", slug),
    cacheStats: (): Promise<PetdexCacheStats> => ipcRenderer.invoke("petdex:cache-stats"),
    clearCache: (): Promise<PetdexCacheStats> => ipcRenderer.invoke("petdex:clear-cache"),
  };
}
