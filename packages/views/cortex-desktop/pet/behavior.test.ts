import { afterEach, describe, expect, it } from "vitest";
import { PET_ENABLED_KEY, loadPetEnabled, savePetEnabled } from "./behavior";

describe("宠物显隐持久化", () => {
  afterEach(() => {
    localStorage.removeItem(PET_ENABLED_KEY);
  });

  it("默认显示(无持久化值时)", () => {
    expect(loadPetEnabled()).toBe(true);
  });

  it("save / load 往返", () => {
    savePetEnabled(false);
    expect(loadPetEnabled()).toBe(false);
    savePetEnabled(true);
    expect(loadPetEnabled()).toBe(true);
  });

  // 只有显式的 "0" 代表隐藏——任何脏值都回落到「显示」,
  // 避免一个坏值让用户彻底看不到宠物且无从恢复。
  it("脏值回落到显示", () => {
    localStorage.setItem(PET_ENABLED_KEY, "bogus");
    expect(loadPetEnabled()).toBe(true);
  });
});
