// pi-extensions.ts 存留纯函数的单测。binary 引擎删除后，渲染/落盘生成器（render*/write*）
// 及其用例一并移除；这里守住共享常量与 normalizePiTodos 的归一化语义。
import { describe, expect, it } from "vitest";

import { DEFAULT_APPROVAL_TOOLS, TODO_TOOL_NAME, normalizePiTodos } from "./pi-extensions";

describe("共享常量", () => {
  it("todo 工具名与审批集缺省值保持稳定（adapter 特判与 native-hooks 同源）", () => {
    expect(TODO_TOOL_NAME).toBe("todo_write");
    expect(DEFAULT_APPROVAL_TOOLS).toEqual(["bash", "write", "edit"]);
  });
});

describe("normalizePiTodos（todo_write 参数归一化）", () => {
  it("合法项透传;未知状态回退 pending;非法项/空文本跳过", () => {
    expect(
      normalizePiTodos({
        todos: [
          { text: "分析", status: "completed" },
          { text: "实现", status: "in_progress" },
          { text: "验证", status: "bogus" },
          { text: "", status: "pending" },
          "not-an-object",
        ],
      }),
    ).toEqual([
      { text: "分析", status: "completed" },
      { text: "实现", status: "in_progress" },
      { text: "验证", status: "pending" },
    ]);
  });

  it("args 缺失/非数组 → 空数组", () => {
    expect(normalizePiTodos(undefined)).toEqual([]);
    expect(normalizePiTodos({})).toEqual([]);
    expect(normalizePiTodos({ todos: "x" })).toEqual([]);
  });
});
