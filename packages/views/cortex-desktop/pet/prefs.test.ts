import { beforeEach, describe, expect, it } from "vitest";
import { usePetStore } from "@cortex-work/core";
import {
  PET_ENABLED_KEY,
  PET_SIZE_KEY,
  PET_SLUG_KEY,
  cleanupLegacyPetKeys,
  loadPetPrefs,
  patchPetPrefs,
} from "./prefs";

beforeEach(() => {
  localStorage.clear();
  usePetStore.setState({ enabled: true, size: 1, sprite: null });
});

describe("loadPetPrefs", () => {
  it("全空时返回默认值", () => {
    expect(loadPetPrefs()).toEqual({ enabled: true, size: 1, slug: null });
  });

  it("读取已保存的合法值", () => {
    localStorage.setItem(PET_ENABLED_KEY, "0");
    localStorage.setItem(PET_SIZE_KEY, "1.5");
    localStorage.setItem(PET_SLUG_KEY, "homelander");
    expect(loadPetPrefs()).toEqual({ enabled: false, size: 1.5, slug: "homelander" });
  });

  // 一个坏值不该让用户彻底看不到宠物、又不知道去哪儿打开。
  it("enabled 只认显式的 0,脏值回落到显示", () => {
    localStorage.setItem(PET_ENABLED_KEY, "bogus");
    expect(loadPetPrefs().enabled).toBe(true);
  });

  it("越界尺寸回落 1", () => {
    localStorage.setItem(PET_SIZE_KEY, "5");
    expect(loadPetPrefs().size).toBe(1);
    localStorage.setItem(PET_SIZE_KEY, "not-a-number");
    expect(loadPetPrefs().size).toBe(1);
  });

  it("空白 slug 视为未选(用内置角色)", () => {
    localStorage.setItem(PET_SLUG_KEY, "   ");
    expect(loadPetPrefs().slug).toBeNull();
  });
});

describe("patchPetPrefs", () => {
  // 这是整个收敛的目的:调用方不需要记得「改 store」+「落盘」两步。
  it("同时更新运行时 store 与持久层", () => {
    patchPetPrefs({ enabled: false });
    expect(usePetStore.getState().enabled).toBe(false);
    expect(localStorage.getItem(PET_ENABLED_KEY)).toBe("0");

    patchPetPrefs({ size: 1.4 });
    expect(usePetStore.getState().size).toBe(1.4);
    expect(loadPetPrefs().size).toBe(1.4);
  });

  it("部分更新不影响其它字段", () => {
    patchPetPrefs({ enabled: false, size: 1.2 });
    patchPetPrefs({ size: 1.6 });
    expect(loadPetPrefs()).toEqual({ enabled: false, size: 1.6, slug: null });
  });

  // slug 只落盘不进 store:store 里存的是解析后的 sprite,解析是异步的。
  it("slug 只落盘,不直接写 store", () => {
    patchPetPrefs({ slug: "sadaharu" });
    expect(loadPetPrefs().slug).toBe("sadaharu");
    expect(usePetStore.getState().sprite).toBeNull();
  });

  it("slug 置 null 即清除(回到内置角色)", () => {
    patchPetPrefs({ slug: "sadaharu" });
    patchPetPrefs({ slug: null });
    expect(loadPetPrefs().slug).toBeNull();
  });
});

describe("cleanupLegacyPetKeys", () => {
  it("清掉已退役特性遗留的 key,不碰在用的", () => {
    for (const k of ["cortex_pet_kind", "cortex_pet_mode", "cortex_pet_walk", "cortex_pet_color"]) {
      localStorage.setItem(k, "x");
    }
    localStorage.setItem(PET_SIZE_KEY, "1.5");

    cleanupLegacyPetKeys();

    for (const k of ["cortex_pet_kind", "cortex_pet_mode", "cortex_pet_walk", "cortex_pet_color"]) {
      expect(localStorage.getItem(k), k).toBeNull();
    }
    expect(localStorage.getItem(PET_SIZE_KEY)).toBe("1.5");
  });

  it("幂等", () => {
    cleanupLegacyPetKeys();
    cleanupLegacyPetKeys();
    expect(loadPetPrefs()).toEqual({ enabled: true, size: 1, slug: null });
  });
});
