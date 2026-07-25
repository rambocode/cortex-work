// budget.ts 的测试。预算是「防跑飞」的最后一道闸门：override 来自渲染进程 / 磁盘 JSON /
// 甚至模型输出，全部不可信，所以这里重点覆盖各种脏值必须回落而不是抛错。
import { describe, expect, it } from "vitest";

import type { ResearchBudget, ResearchMode } from "./types";

import { clampResearchBudget, HARD_BUDGET_CEILING, MODE_BUDGETS } from "./budget";

const BUDGET_KEYS: Array<keyof ResearchBudget> = [
  "maxRounds",
  "maxQueries",
  "maxCandidates",
  "maxDocuments",
  "maxBrowserFetches",
  "maxDurationMs",
  "maxEvidenceCharsToModel",
];

describe("MODE_BUDGETS", () => {
  it.each([
    ["quick", { maxRounds: 1, maxQueries: 4, maxDocuments: 8, maxBrowserFetches: 1, maxDurationMs: 90_000 }],
    ["standard", { maxRounds: 3, maxQueries: 16, maxDocuments: 24, maxBrowserFetches: 5, maxDurationMs: 600_000 }],
    ["deep", { maxRounds: 5, maxQueries: 32, maxDocuments: 50, maxBrowserFetches: 10, maxDurationMs: 1_800_000 }],
  ] as Array<[ResearchMode, Partial<ResearchBudget>]>)("%s 的默认值符合 spec §8.1", (mode, expected) => {
    expect(MODE_BUDGETS[mode]).toMatchObject(expected);
  });

  it("maxCandidates 是 maxDocuments 的 3 倍（候选池要显著大于目标文档数）", () => {
    for (const mode of ["quick", "standard", "deep"] as ResearchMode[]) {
      expect(MODE_BUDGETS[mode].maxCandidates).toBe(MODE_BUDGETS[mode].maxDocuments * 3);
    }
  });

  it("模式越深预算越大（三档单调递增）", () => {
    for (const key of BUDGET_KEYS) {
      expect(MODE_BUDGETS.quick[key]).toBeLessThan(MODE_BUDGETS.standard[key]);
      expect(MODE_BUDGETS.standard[key]).toBeLessThan(MODE_BUDGETS.deep[key]);
    }
  });

  it("所有默认值都在硬上限以内（否则夹取会把默认值也削掉）", () => {
    for (const mode of ["quick", "standard", "deep"] as ResearchMode[]) {
      for (const key of BUDGET_KEYS) {
        expect(MODE_BUDGETS[mode][key]).toBeLessThanOrEqual(HARD_BUDGET_CEILING[key]);
      }
    }
  });

  it("所有字段都是正整数", () => {
    for (const mode of ["quick", "standard", "deep"] as ResearchMode[]) {
      for (const key of BUDGET_KEYS) {
        expect(Number.isInteger(MODE_BUDGETS[mode][key])).toBe(true);
        expect(MODE_BUDGETS[mode][key]).toBeGreaterThan(0);
      }
    }
  });
});

describe("clampResearchBudget 基线", () => {
  it.each(["quick", "standard", "deep"] as ResearchMode[])("%s 无 override 时等于模式默认值", (mode) => {
    expect(clampResearchBudget(mode)).toEqual(MODE_BUDGETS[mode]);
  });

  it.each(["quick", "standard", "deep"] as ResearchMode[])("%s 空 override 时等于模式默认值", (mode) => {
    expect(clampResearchBudget(mode, {})).toEqual(MODE_BUDGETS[mode]);
  });

  it("返回的是新对象，改它不会污染 MODE_BUDGETS", () => {
    const budget = clampResearchBudget("standard");
    budget.maxRounds = 99;
    expect(MODE_BUDGETS.standard.maxRounds).toBe(3);
  });
});

describe("clampResearchBudget 上限夹取", () => {
  it.each(BUDGET_KEYS)("%s 超过硬上限时被夹到上限", (key) => {
    const result = clampResearchBudget("standard", { [key]: HARD_BUDGET_CEILING[key] + 1000 });
    expect(result[key]).toBe(HARD_BUDGET_CEILING[key]);
  });

  it.each(BUDGET_KEYS)("%s 恰好等于硬上限时原样保留", (key) => {
    const result = clampResearchBudget("quick", { [key]: HARD_BUDGET_CEILING[key] });
    expect(result[key]).toBe(HARD_BUDGET_CEILING[key]);
  });

  it("Number.MAX_SAFE_INTEGER 也被夹住", () => {
    const result = clampResearchBudget("deep", { maxDocuments: Number.MAX_SAFE_INTEGER });
    expect(result.maxDocuments).toBe(HARD_BUDGET_CEILING.maxDocuments);
  });
});

describe("clampResearchBudget 脏值回落", () => {
  const dirtyValues: Array<[string, unknown]> = [
    ["0", 0],
    ["负数", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["字符串", "8"],
    ["null", null],
    ["布尔", true],
    ["对象", {}],
  ];

  for (const key of BUDGET_KEYS) {
    it.each(dirtyValues)(`${key} 为 %s 时回落基线值`, (_name, raw) => {
      const result = clampResearchBudget("standard", { [key]: raw } as Partial<ResearchBudget>);
      expect(result[key]).toBe(MODE_BUDGETS.standard[key]);
    });
  }

  it.each(BUDGET_KEYS.filter((k) => k !== "maxDurationMs"))("%s 为非整数时回落基线值", (key) => {
    const result = clampResearchBudget("deep", { [key]: 2.5 });
    expect(result[key]).toBe(MODE_BUDGETS.deep[key]);
  });

  it("maxDurationMs 允许非整数（毫秒小数无害）", () => {
    expect(clampResearchBudget("quick", { maxDurationMs: 1234.5 }).maxDurationMs).toBe(1234.5);
  });

  it("undefined 字段视为未覆盖", () => {
    const result = clampResearchBudget("deep", { maxRounds: undefined, maxQueries: 2 });
    expect(result.maxRounds).toBe(MODE_BUDGETS.deep.maxRounds);
    expect(result.maxQueries).toBe(2);
  });

  it("override 非对象（脏 JSON）不抛错，返回基线", () => {
    expect(clampResearchBudget("quick", null as unknown as Partial<ResearchBudget>)).toEqual(
      MODE_BUDGETS.quick,
    );
    expect(clampResearchBudget("quick", "bad" as unknown as Partial<ResearchBudget>)).toEqual(
      MODE_BUDGETS.quick,
    );
  });

  it("未知 mode 回落到最保守的 quick 预算", () => {
    expect(clampResearchBudget("turbo" as ResearchMode)).toEqual(MODE_BUDGETS.quick);
  });
});

describe("clampResearchBudget 部分覆盖", () => {
  it("只覆盖两个字段时其余保持基线", () => {
    const result = clampResearchBudget("standard", { maxRounds: 2, maxDurationMs: 120_000 });
    expect(result).toEqual({
      ...MODE_BUDGETS.standard,
      maxRounds: 2,
      maxDurationMs: 120_000,
    });
  });

  it("调低（比基线更小的合法值）会被采纳——夹取只防超限，不阻止收紧", () => {
    const result = clampResearchBudget("deep", { maxDocuments: 3 });
    expect(result.maxDocuments).toBe(3);
  });

  it("一个字段脏、一个字段合法时互不影响", () => {
    const result = clampResearchBudget("standard", {
      maxRounds: Number.NaN,
      maxQueries: 5,
    });
    expect(result.maxRounds).toBe(MODE_BUDGETS.standard.maxRounds);
    expect(result.maxQueries).toBe(5);
  });
});

describe("HARD_BUDGET_CEILING", () => {
  it("每个字段都是正整数", () => {
    for (const key of BUDGET_KEYS) {
      expect(Number.isInteger(HARD_BUDGET_CEILING[key])).toBe(true);
      expect(HARD_BUDGET_CEILING[key]).toBeGreaterThan(0);
    }
  });

  it("不低于 deep 模式默认值（deep 是最大的一档）", () => {
    for (const key of BUDGET_KEYS) {
      expect(HARD_BUDGET_CEILING[key]).toBeGreaterThanOrEqual(MODE_BUDGETS.deep[key]);
    }
  });
});
