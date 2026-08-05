// 宠物兜底造型完整性与尺寸持久化的单元测试。

import { beforeEach, describe, expect, it } from "vitest";
import { PET_DESIGNS, PET_SIZE_KEY, loadPetSize } from "./designs";

describe("PET_DESIGNS", () => {
  it("cat / dog / mint 均有完整造型(name/desc/Parts)", () => {
    for (const kind of ["cat", "dog", "mint"] as const) {
      const design = PET_DESIGNS[kind];
      expect(design.name, `${kind}.name`).toBeTruthy();
      expect(design.desc, `${kind}.desc`).toBeTruthy();
      expect(typeof design.Parts, `${kind}.Parts`).toBe("function");
    }
  });
});

describe("loadPetSize", () => {
  beforeEach(() => localStorage.clear());

  it("未设置时返回默认值", () => {
    expect(loadPetSize()).toBe(1);
  });

  it("读取已保存的合法值", () => {
    localStorage.setItem(PET_SIZE_KEY, "1.5");
    expect(loadPetSize()).toBe(1.5);
  });

  it("越界尺寸回落默认", () => {
    localStorage.setItem(PET_SIZE_KEY, "5");
    expect(loadPetSize()).toBe(1);
  });
});
