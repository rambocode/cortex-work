// 图鉴数据的来源适配。**这是 Desktop 与 Web 唯一的分叉点**,其余代码对两者无感。
//
// Desktop  走主进程:磁盘缓存 + 离线兜底 + 出网白名单都在那边(见 main/ipc/petdex.ts),
//          渲染端拿到的是 cortex-petdex:// 的本地 URL。
// Web      直连 https:实测 petdex 的 manifest 与 sprite 都返回
//          `access-control-allow-origin: *`,且本仓两端都没有 CSP,直连可行;
//          Web 没有离线诉求,不需要磁盘缓存。网格靠 Image 的 naturalWidth/Height 探测。

import type { DesktopBridge } from "@cortex-work/core";
import type {
  PetSpriteSource,
  PetdexEntry,
  PetdexManifestResult,
} from "@cortex-work/core/desktop/petdex-types";
import { detectPetdexGrid } from "@cortex-work/core/pet/grid";

const MANIFEST_URL = "https://assets.petdex.dev/manifests/petdex-v1.json";

export interface PetdexSource {
  getManifest(opts?: { force?: boolean }): Promise<PetdexManifestResult>;
  /** 解析成可直接渲染的 sprite 描述符;不可用时返回 null(调用方回落内置角色)。 */
  resolveSprite(slug: string, displayName?: string): Promise<PetSpriteSource | null>;
  /** 只查本地、绝不联网(启动恢复用)。Web 无本地缓存,恒返 null。 */
  peekSprite(slug: string): Promise<PetSpriteSource | null>;
}

export function createDesktopPetdexSource(bridge: NonNullable<DesktopBridge["petdex"]>): PetdexSource {
  const toSource = (ref: { slug: string; displayName: string; url: string; cols: number; rows: number }) => ({
    origin: "petdex" as const,
    id: ref.slug,
    url: ref.url,
    cols: ref.cols,
    rows: ref.rows,
    displayName: ref.displayName,
  });
  return {
    getManifest: (opts) => bridge.getManifest(opts),
    resolveSprite: async (slug) => {
      try {
        return toSource(await bridge.ensureSprite(slug));
      } catch {
        return null; // 下载失败:回落内置角色,别让宠物消失
      }
    },
    peekSprite: async (slug) => {
      try {
        const ref = await bridge.peekSprite(slug);
        return ref ? toSource(ref) : null;
      } catch {
        return null;
      }
    },
  };
}

/** Web 侧:manifest 只在内存里缓存一个会话(靠 HTTP 的 s-maxage=300 + SWR=3600 兜住)。 */
let webManifest: PetdexManifestResult | null = null;

export function createWebPetdexSource(): PetdexSource {
  async function manifest(force?: boolean): Promise<PetdexManifestResult> {
    if (webManifest && !force) return webManifest;
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`petdex: HTTP ${res.status}`);
    const raw = (await res.json()) as { pets?: PetdexEntry[] };
    const pets = Array.isArray(raw.pets) ? raw.pets : [];
    webManifest = { pets, total: pets.length, fetchedAt: Date.now(), stale: false };
    return webManifest;
  }

  return {
    getManifest: (opts) => manifest(opts?.force),
    resolveSprite: async (slug, displayName) => {
      const entry = (await manifest()).pets.find((p) => p.slug === slug);
      if (!entry) return null;
      // Web 没有主进程解析 WebP 头部,只能等图片解码后读 naturalWidth/Height。
      const grid = await new Promise<{ cols: number; rows: number } | null>((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(detectPetdexGrid(img.naturalWidth, img.naturalHeight));
        img.onerror = () => resolve(null);
        img.src = entry.spritesheetUrl;
      });
      if (!grid) return null;
      return {
        origin: "petdex",
        id: slug,
        url: entry.spritesheetUrl,
        cols: grid.cols,
        rows: grid.rows,
        displayName: displayName ?? entry.displayName,
      };
    },
    // Web 没有本地缓存:恒返 null,由调用方走 resolveSprite 的网络路径。
    peekSprite: async () => null,
  };
}

export function createPetdexSource(bridge: DesktopBridge | null | undefined): PetdexSource {
  return bridge?.petdex ? createDesktopPetdexSource(bridge.petdex) : createWebPetdexSource();
}
