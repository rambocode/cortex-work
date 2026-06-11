// 宠物自定义配色派生与尺寸/颜色持久化的单元测试。

import { beforeEach, describe, expect, it } from "vitest";
import {
  PET_COLOR_KEY,
  PET_SIZE_KEY,
  loadPetColor,
  loadPetSize,
  petColorVars,
} from "./designs";

describe("petColorVars", () => {
  it("由主色派生 main/dark/light 三档", () => {
    const vars = petColorVars("#ecb98a");
    expect(vars).not.toBeNull();
    expect(vars!["--pet-main"]).toBe("#ecb98a");
    expect(vars!["--pet-dark"]).toMatch(/^#[0-9a-f]{6}$/);
    expect(vars!["--pet-light"]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("dark 比主色暗,light 比主色亮", () => {
    const lum = (hex: string) =>
      parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
    const vars = petColorVars("#a3c4e8")!;
    expect(lum(vars["--pet-dark"]!)).toBeLessThan(lum(vars["--pet-main"]!));
    expect(lum(vars["--pet-light"]!)).toBeGreaterThan(lum(vars["--pet-main"]!));
  });

  it("支持 3 位 hex 与省略 # 前缀", () => {
    expect(petColorVars("#fa0")!["--pet-main"]).toBe("#ffaa00");
    expect(petColorVars("ffaa00")!["--pet-main"]).toBe("#ffaa00");
  });

  it("无效输入返回 null", () => {
    expect(petColorVars("")).toBeNull();
    expect(petColorVars("red")).toBeNull();
    expect(petColorVars("#12345")).toBeNull();
  });
});

describe("loadPetSize / loadPetColor", () => {
  beforeEach(() => localStorage.clear());

  it("未设置时返回默认值", () => {
    expect(loadPetSize()).toBe(1);
    expect(loadPetColor()).toBeNull();
  });

  it("读取已保存的合法值", () => {
    localStorage.setItem(PET_SIZE_KEY, "1.5");
    localStorage.setItem(PET_COLOR_KEY, "#a3c4e8");
    expect(loadPetSize()).toBe(1.5);
    expect(loadPetColor()).toBe("#a3c4e8");
  });

  it("越界尺寸与非法颜色回落默认", () => {
    localStorage.setItem(PET_SIZE_KEY, "5");
    localStorage.setItem(PET_COLOR_KEY, "not-a-color");
    expect(loadPetSize()).toBe(1);
    expect(loadPetColor()).toBeNull();
  });
});
