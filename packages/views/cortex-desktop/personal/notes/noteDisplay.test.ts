import { describe, expect, it } from "vitest";
import { noteTitle } from "./noteDisplay";

describe("noteTitle", () => {
  it("取首个非空行", () => {
    expect(noteTitle("\n\n第一行想法\n第二行")).toBe("第一行想法");
  });

  it("首行是标题时剥掉 # 标记", () => {
    expect(noteTitle("# 标题文字\n正文")).toBe("标题文字");
    expect(noteTitle("### 三级标题")).toBe("三级标题");
  });

  it("剥掉行首引用 / 列表标记", () => {
    expect(noteTitle("> 引用一句")).toBe("引用一句");
    expect(noteTitle("- 列表项")).toBe("列表项");
    expect(noteTitle("1. 有序项")).toBe("有序项");
  });

  it("孤立的 # 等无内容标记回退原行,不返回空", () => {
    expect(noteTitle("#")).toBe("#");
  });

  it("空白闪记给占位", () => {
    expect(noteTitle("   \n\n  ")).toBe("（空白闪记）");
  });

  it("超长截断到 80 字 + 省略号", () => {
    const long = "# " + "字".repeat(100);
    const t = noteTitle(long);
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBe(81); // 80 字 + …
  });
});
