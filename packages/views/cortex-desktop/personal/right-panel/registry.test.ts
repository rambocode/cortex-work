// 注册表完整性单测:集中清单是右栏面板的唯一真相,这里兜住「加面板漏字段/撞 id/
// 懒加载入口指错文件」这类静默故障。
import { describe, expect, it } from "vitest";
import { ALL_PANELS, RIGHT_PANELS, railItems, resolvePanel } from "./registry";

describe("右栏面板注册表完整性", () => {
  it("11 个内置面板齐全且 id 唯一", () => {
    const ids = RIGHT_PANELS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      [
        "artifact",
        "browser",
        "canvas",
        "files",
        "knowledge",
        "notes",
        "piArtifacts",
        "research",
        "skills",
        "subagents",
        "todos",
      ].sort(),
    );
  });

  it("必填字段非空;rail 项必须带图标且 order 唯一", () => {
    for (const panel of ALL_PANELS) {
      expect(panel.id).toBeTruthy();
      expect(panel.title).toBeTruthy();
      expect(["normal", "wide"]).toContain(panel.widthTier);
      expect(typeof panel.load).toBe("function");
      if (panel.rail) expect(panel.icon).toBeTruthy();
    }
    const orders = railItems().map((p) => p.rail?.order);
    expect(new Set(orders).size).toBe(orders.length);
  });

  it("rail 派生清单顺序与历史 ITEMS 一致（files/skills/todos/notes/browser/canvas/subagents）", () => {
    expect(railItems().map((p) => p.id)).toEqual([
      "files",
      "skills",
      "todos",
      "notes",
      "browser",
      "canvas",
      "subagents",
    ]);
  });

  it("resolvePanel 未知 id 回退 files", () => {
    expect(resolvePanel("files").id).toBe("files");
    expect(resolvePanel("no-such-panel").id).toBe("files");
  });

  it("全部懒加载入口可解析出组件（防 import 路径指错）", async () => {
    for (const panel of ALL_PANELS) {
      const mod = await panel.load();
      expect(typeof mod.default).toBe("function");
    }
  });
});
