// 镜像守卫：main/ipc/types.ts 里那批「与 core/desktop/types.ts 逐字镜像」的工具名常量，
// 靠注释约束是拦不住人的 —— 漂移的后果又特别隐蔽：
//   · 审批集常量漂移 → 审批 extension 的 NEEDS 集匹配不到工具名 → **静默放行**（不是报错）；
//   · plan 白名单漂移 → pi 的 --tools 与渲染端的「被拦提示」判断不一致。
// 故用一条测试把两侧钉死。新增镜像常量时记得在下面的表里补一行。

import { describe, expect, it } from "vitest";
import * as core from "@cortex-work/core/desktop/types";
import * as main from "./types";

describe("core ↔ main 工具名常量镜像", () => {
  const pairs: Array<[string, readonly string[], readonly string[]]> = [
    ["COMPUTER_USE_READONLY_TOOLS", core.COMPUTER_USE_READONLY_TOOLS, main.COMPUTER_USE_READONLY_TOOLS],
    ["COMPUTER_USE_WRITE_TOOLS", core.COMPUTER_USE_WRITE_TOOLS, main.COMPUTER_USE_WRITE_TOOLS],
    ["AUTOMATION_READONLY_TOOLS", core.AUTOMATION_READONLY_TOOLS, main.AUTOMATION_READONLY_TOOLS],
    ["AUTOMATION_WRITE_TOOLS", core.AUTOMATION_WRITE_TOOLS, main.AUTOMATION_WRITE_TOOLS],
    ["CALENDAR_READONLY_TOOLS", core.CALENDAR_READONLY_TOOLS, main.CALENDAR_READONLY_TOOLS],
    ["CALENDAR_WRITE_TOOLS", core.CALENDAR_WRITE_TOOLS, main.CALENDAR_WRITE_TOOLS],
    ["PI_PLAN_TOOL_WHITELIST", core.PI_PLAN_TOOL_WHITELIST, main.PI_PLAN_TOOL_WHITELIST],
  ];

  it.each(pairs)("%s 两侧逐字相等（含顺序）", (_name, a, b) => {
    expect(b).toEqual(a);
  });

  it("COMPUTER_USE_SOURCE_REF 两侧一致（钉版本是供应链漂移的唯一防线）", () => {
    expect(main.COMPUTER_USE_SOURCE_REF).toBe(core.COMPUTER_USE_SOURCE_REF);
  });

  it("写工具与只读工具无交集（同名工具同时被审批与放行是自相矛盾的）", () => {
    const readonly = new Set([
      ...core.COMPUTER_USE_READONLY_TOOLS,
      ...core.AUTOMATION_READONLY_TOOLS,
      ...core.CALENDAR_READONLY_TOOLS,
    ]);
    for (const tool of [
      ...core.COMPUTER_USE_WRITE_TOOLS,
      ...core.AUTOMATION_WRITE_TOOLS,
      ...core.CALENDAR_WRITE_TOOLS,
    ]) {
      expect(readonly.has(tool)).toBe(false);
    }
  });

  it("plan 白名单不含任何写工具（plan 的只读承诺由 --tools 物理兑现）", () => {
    for (const tool of [
      ...core.COMPUTER_USE_WRITE_TOOLS,
      ...core.AUTOMATION_WRITE_TOOLS,
      ...core.CALENDAR_WRITE_TOOLS,
    ]) {
      expect(core.PI_PLAN_TOOL_WHITELIST).not.toContain(tool);
    }
  });
});
