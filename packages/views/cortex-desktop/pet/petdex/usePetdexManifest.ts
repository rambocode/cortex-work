// 图鉴索引的取用与筛选。
//
// 索引有 4374 条(瘦身后约 650KB)。它被放在**模块级缓存**而不是 React state:
// 4374 个对象每次都进 reconciler 的依赖比较是白白的开销,而这份数据在一个会话里
// 几乎不变。筛选/分页都是纯函数,在数组上跑一次 filter 不到 1ms,不需要建索引。

import { useCallback, useEffect, useState } from "react";
import type { DesktopBridge } from "@cortex-work/core";
import type { PetdexEntry, PetdexManifestResult } from "@cortex-work/core/desktop/petdex-types";
import { createPetdexSource } from "../petdexSource";

/** 每页条数。刻意用分页而不是无限滚动,理由见 PetdexGallery 头注释。 */
export const PAGE_SIZE = 24;

export type PetdexKindFilter = "all" | PetdexEntry["kind"];

export interface PetdexFilter {
  query: string;
  kind: PetdexKindFilter;
}

/** 按关键词 + 类别筛选。关键词同时匹配展示名与 slug(用户可能记得任意一个)。 */
export function filterPets(pets: PetdexEntry[], filter: PetdexFilter): PetdexEntry[] {
  const q = filter.query.trim().toLowerCase();
  if (!q && filter.kind === "all") return pets;
  return pets.filter((p) => {
    if (filter.kind !== "all" && p.kind !== filter.kind) return false;
    if (!q) return true;
    return p.displayName.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q);
  });
}

/** 取第 page 页(0-based)。越界返回空数组,不抛。 */
export function pageOf<T>(list: T[], page: number, size = PAGE_SIZE): T[] {
  return list.slice(page * size, page * size + size);
}

export function pageCount(total: number, size = PAGE_SIZE): number {
  return Math.max(1, Math.ceil(total / size));
}

/**
 * 抽 n 只作为「随便看看」的入口。
 * 4374 只按名字翻 183 页没有意义,用户要么搜、要么随缘 —— 这是主要的探索路径。
 * seed 由调用方递增,使「换一批」可复现且不依赖 Math.random 的调用时机。
 */
export function samplePets(pets: PetdexEntry[], n: number, seed: number): PetdexEntry[] {
  if (pets.length <= n) return pets;
  const out: PetdexEntry[] = [];
  // 线性同余步进取样:等距跳着取,既分散又不会重复,且同一 seed 结果稳定。
  const stride = 1 + ((seed * 2654435761) % (pets.length - 1));
  let idx = (seed * 40503) % pets.length;
  const seen = new Set<number>();
  while (out.length < n && seen.size < pets.length) {
    if (!seen.has(idx)) {
      seen.add(idx);
      const pet = pets[idx];
      if (pet) out.push(pet);
    }
    idx = (idx + stride) % pets.length;
  }
  return out;
}

// 会话级缓存:同一次运行里重复打开图鉴不再重复拉取。
let cached: PetdexManifestResult | null = null;

export interface PetdexManifestState {
  pets: PetdexEntry[];
  total: number;
  /** true = 展示的是磁盘旧副本,应提示离线。 */
  stale: boolean;
  loading: boolean;
  error: string | null;
  reload: (force?: boolean) => void;
}

export function usePetdexManifest(bridge: DesktopBridge | null | undefined, enabled: boolean): PetdexManifestState {
  const [state, setState] = useState<Omit<PetdexManifestState, "reload">>({
    pets: cached?.pets ?? [],
    total: cached?.total ?? 0,
    stale: cached?.stale ?? false,
    loading: false,
    error: null,
  });

  const load = useCallback(
    (force?: boolean) => {
      if (cached && !force) {
        setState({ pets: cached.pets, total: cached.total, stale: cached.stale, loading: false, error: null });
        return;
      }
      setState((s) => ({ ...s, loading: true, error: null }));
      void createPetdexSource(bridge)
        .getManifest({ force })
        .then((res) => {
          cached = res;
          setState({ pets: res.pets, total: res.total, stale: res.stale, loading: false, error: null });
        })
        .catch((err: unknown) => {
          setState((s) => ({ ...s, loading: false, error: err instanceof Error ? err.message : String(err) }));
        });
    },
    [bridge],
  );

  // 懒加载:只在图鉴真正打开时才拉。启动路径上多一个 650KB 的请求收益为零。
  useEffect(() => {
    if (enabled) load();
  }, [enabled, load]);

  return { ...state, reload: load };
}
