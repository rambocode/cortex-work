import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCortexUIStore } from "./ui";

// 全局提醒 store 行为:向后兼容 + 富字段 + 自动/手动消失。
describe("useCortexUIStore pushToast/dismissToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useCortexUIStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("向后兼容:text-only 调用产出 info 默认图标、可关闭的提醒", () => {
    useCortexUIStore.getState().pushToast("已切换");
    const [t] = useCortexUIStore.getState().toasts;
    expect(t.text).toBe("已切换");
    expect(t.kind).toBe("info");
    expect(t.dismissible).toBe(true);
    expect(t.iconName).toBe("Info");
    expect(t.title).toBeUndefined();
  });

  it("富内容:title/description 与 kind 默认图标(success→CheckCircle)", () => {
    useCortexUIStore
      .getState()
      .pushToast("", { title: "5h 配额已重置", description: "Codex 可以继续使用", kind: "success" });
    const [t] = useCortexUIStore.getState().toasts;
    expect(t.title).toBe("5h 配额已重置");
    expect(t.description).toBe("Codex 可以继续使用");
    expect(t.iconName).toBe("CheckCircle");
  });

  it("error kind 默认图标为 XCircle", () => {
    useCortexUIStore.getState().pushToast("失败", { kind: "error" });
    expect(useCortexUIStore.getState().toasts[0].iconName).toBe("XCircle");
  });

  it("显式 icon 覆盖 kind 默认映射", () => {
    useCortexUIStore.getState().pushToast("提示", { icon: "Bell" });
    expect(useCortexUIStore.getState().toasts[0].iconName).toBe("Bell");
  });

  it("默认 duration(2400ms)到点后自动移除", () => {
    useCortexUIStore.getState().pushToast("临时");
    expect(useCortexUIStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(2400);
    expect(useCortexUIStore.getState().toasts).toHaveLength(0);
  });

  it("duration:0 常驻,不自动移除", () => {
    useCortexUIStore.getState().pushToast("常驻", { duration: 0 });
    vi.advanceTimersByTime(60_000);
    expect(useCortexUIStore.getState().toasts).toHaveLength(1);
  });

  it("dismissToast 仅移除指定条,其余保留", () => {
    const store = useCortexUIStore.getState();
    store.pushToast("第一条", { duration: 0 });
    store.pushToast("第二条", { duration: 0 });
    const first = useCortexUIStore.getState().toasts[0];
    useCortexUIStore.getState().dismissToast(first.id);
    const remaining = useCortexUIStore.getState().toasts;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe("第二条");
  });
});
