// 快捷指令数据模型单测:内置默认集、归一化(补齐内置/mode 固定/自定义去重与上限)、解析(禁用/缺文案过滤)。
import { describe, it, expect } from "vitest";
import {
  WRITING_QUICK_ACTION_BUILTIN_IDS,
  WRITING_QUICK_ACTION_MAX_CUSTOM,
  countCustomQuickActions,
  defaultWritingQuickActions,
  isBuiltinQuickAction,
  newCustomQuickActionId,
  normalizeWritingQuickActions,
  resolveWritingQuickActions,
} from "./quick-actions";
import type { WritingQuickAction } from "../desktop/writing-types";

describe("writing quick actions 数据模型", () => {
  it("默认集 = 全部内置、留空文案、启用、reformat=edit 其余 chat", () => {
    const def = defaultWritingQuickActions();
    expect(def.map((a) => a.id)).toEqual(WRITING_QUICK_ACTION_BUILTIN_IDS);
    expect(def.every((a) => a.enabled && a.label === "" && a.prompt === "")).toBe(true);
    expect(def.find((a) => a.id === "reformat")?.mode).toBe("edit");
    expect(def.find((a) => a.id === "polish")?.mode).toBe("chat");
  });

  it("normalize(空/旧档)→ 内置默认集", () => {
    expect(normalizeWritingQuickActions(undefined)).toEqual(defaultWritingQuickActions());
  });

  it("normalize 补齐缺失内置、内置 mode 不受篡改、保留 enabled/label 覆盖", () => {
    const input: WritingQuickAction[] = [
      // 只存一个内置且篡改 mode + 禁用 + 覆盖 label
      { id: "polish", label: "打磨", prompt: "", mode: "edit", enabled: false },
    ];
    const out = normalizeWritingQuickActions(input);
    expect(out.map((a) => a.id)).toEqual(WRITING_QUICK_ACTION_BUILTIN_IDS); // 内置全补齐
    const polish = out.find((a) => a.id === "polish")!;
    expect(polish.mode).toBe("chat"); // 内置 mode 固定,篡改无效
    expect(polish.enabled).toBe(false); // 禁用保留
    expect(polish.label).toBe("打磨"); // label 覆盖保留
  });

  it("normalize 自定义:去重 + 夹上限 12,内置恒在前", () => {
    const custom: WritingQuickAction[] = Array.from({ length: 15 }, (_, i) => ({
      id: `custom-${i}`,
      label: `c${i}`,
      prompt: `p${i}`,
      mode: "chat",
      enabled: true,
    }));
    const out = normalizeWritingQuickActions(custom);
    expect(countCustomQuickActions(out)).toBe(WRITING_QUICK_ACTION_MAX_CUSTOM); // 截断到 12
    // 前 9 项为内置
    expect(out.slice(0, WRITING_QUICK_ACTION_BUILTIN_IDS.length).map((a) => a.id)).toEqual(
      WRITING_QUICK_ACTION_BUILTIN_IDS,
    );
  });

  it("resolve:禁用项过滤;内置留空用 i18n 默认;缺 label/prompt 丢弃", () => {
    const actions: WritingQuickAction[] = [
      { id: "polish", label: "", prompt: "", mode: "chat", enabled: true },
      { id: "explain", label: "", prompt: "", mode: "chat", enabled: false }, // 禁用
      { id: "custom-x", label: "自定义", prompt: "", mode: "chat", enabled: true }, // 缺 prompt
      { id: "custom-y", label: "有效", prompt: "做点什么", mode: "edit", enabled: true },
    ];
    const resolved = resolveWritingQuickActions(actions, (id) =>
      id === "polish" ? { label: "润色", prompt: "润色这段" } : null,
    );
    expect(resolved.map((a) => a.id)).toEqual(["polish", "custom-y"]);
    expect(resolved[0]).toMatchObject({ id: "polish", label: "润色", prompt: "润色这段", mode: "chat" });
    expect(resolved[1]).toMatchObject({ id: "custom-y", mode: "edit" });
  });

  it("id/工具函数", () => {
    expect(isBuiltinQuickAction("polish")).toBe(true);
    expect(isBuiltinQuickAction("custom-1")).toBe(false);
    expect(newCustomQuickActionId()).toMatch(/^custom-/);
  });
});
