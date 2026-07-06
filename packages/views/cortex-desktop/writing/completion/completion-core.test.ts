// ghost text 续写 CM 无关纯逻辑单测(U3):前后缀窗口、触发判定、Tab 采纳位移。
import { describe, it, expect } from "vitest";
import {
  WRITING_COMPLETION_DEBOUNCE_MS,
  buildCompletionWindows,
  shouldRequestCompletion,
  computeGhostAccept,
} from "./completion-core";

describe("buildCompletionWindows", () => {
  it("prefix 取光标前(保尾)、suffix 取光标后(保头)", () => {
    const doc = "0123456789";
    const { prefix, suffix } = buildCompletionWindows(doc, 5);
    expect(prefix).toBe("01234");
    expect(suffix).toBe("56789");
  });
  it("超窗按窗口夹取", () => {
    const doc = "a".repeat(7000) + "b".repeat(5000);
    const { prefix, suffix } = buildCompletionWindows(doc, 7000);
    expect(prefix.length).toBe(6000);
    expect(suffix.length).toBe(4000);
    expect(prefix.endsWith("a")).toBe(true);
    expect(suffix.startsWith("b")).toBe(true);
  });
});

describe("shouldRequestCompletion", () => {
  it("启用且前缀有实义字符 → true", () => {
    expect(shouldRequestCompletion(true, "hello")).toBe(true);
  });
  it("未启用 → false", () => {
    expect(shouldRequestCompletion(false, "hello")).toBe(false);
  });
  it("前缀空/纯空白 → false", () => {
    expect(shouldRequestCompletion(true, "")).toBe(false);
    expect(shouldRequestCompletion(true, "  \n ")).toBe(false);
  });
});

describe("computeGhostAccept", () => {
  it("在光标处插入 ghost 文本,光标移到插入末尾", () => {
    const r = computeGhostAccept("hello", 5, " world");
    expect(r.from).toBe(5);
    expect(r.insert).toBe(" world");
    expect(r.anchor).toBe(11);
  });
});

it("去抖阈值 ≥600ms(打字停顿后才请求)", () => {
  expect(WRITING_COMPLETION_DEBOUNCE_MS).toBeGreaterThanOrEqual(600);
});
