import { describe, it, expect } from "vitest";
import { parseEncouragement, buildEncouragePrompt } from "./encourage";

describe("parseEncouragement", () => {
  it("解析标准两行格式", () => {
    expect(parseEncouragement("标题：稳住节奏\n副标题：一步一步来,你可以的。")).toEqual({
      title: "稳住节奏",
      sub: "一步一步来,你可以的。",
    });
  });

  it("容忍英文冒号与多余空白/引号", () => {
    expect(parseEncouragement('标题:  「先做一件小事」 \n副标题:  "节奏就回来了"  ')).toEqual({
      title: "先做一件小事",
      sub: "节奏就回来了",
    });
  });

  it("缺任一行则返回 null（回退静态兜底）", () => {
    expect(parseEncouragement("标题：只有标题")).toBeNull();
    expect(parseEncouragement("随便一段没有格式的输出")).toBeNull();
  });
});

describe("buildEncouragePrompt", () => {
  it("按时段注入时段词且要求固定输出格式", () => {
    const p = buildEncouragePrompt(new Date("2026-06-19T08:00:00"));
    expect(p).toContain("清晨");
    expect(p).toContain("标题：");
    expect(p).toContain("副标题：");
  });
});
