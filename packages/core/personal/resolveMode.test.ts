import { describe, expect, it } from "vitest";
import { resolveEffectiveMode } from "./resolveMode";

describe("resolveEffectiveMode", () => {
  it("非 auto 档原样返回,prompt 不影响", () => {
    expect(resolveEffectiveMode("plan", "修复这个 bug")).toBe("plan");
    expect(resolveEffectiveMode("accept-edits", "解释一下")).toBe("accept-edits");
    expect(resolveEffectiveMode("full-auto", "随便")).toBe("full-auto");
  });

  it("auto + 裸祈使动作词 → accept-edits", () => {
    expect(resolveEffectiveMode("auto", "修复登录 bug")).toBe("accept-edits");
    expect(resolveEffectiveMode("auto", "实现导出功能")).toBe("accept-edits");
    expect(resolveEffectiveMode("auto", "修改一下样式")).toBe("accept-edits");
    expect(resolveEffectiveMode("auto", "fix the login crash")).toBe("accept-edits");
    expect(resolveEffectiveMode("auto", "重构这个模块")).toBe("accept-edits");
  });

  it("auto + 疑问引导(如何/怎么/是否)即便含动作词 → plan", () => {
    expect(resolveEffectiveMode("auto", "如何修复这个内存泄漏")).toBe("plan");
    expect(resolveEffectiveMode("auto", "解释怎么实现登录")).toBe("plan");
    expect(resolveEffectiveMode("auto", "是否应该修改这里")).toBe("plan");
    expect(resolveEffectiveMode("auto", "how should I implement this")).toBe("plan");
  });

  it("auto + 纯问答/规划 → plan", () => {
    expect(resolveEffectiveMode("auto", "解释这段代码")).toBe("plan");
    expect(resolveEffectiveMode("auto", "帮我规划方案")).toBe("plan");
  });

  it("auto + 英文动作词作子串不误命中(词边界,评审 F1)", () => {
    // address 含 add、changes 含 change、implementation 含 implement、refactoring 含 refactor、credit 含 edit
    expect(resolveEffectiveMode("auto", "what is the memory address?")).toBe("plan");
    expect(resolveEffectiveMode("auto", "summarize the changes please")).toBe("plan");
    expect(resolveEffectiveMode("auto", "describe the implementation details")).toBe("plan");
    expect(resolveEffectiveMode("auto", "what credit card parsing is used")).toBe("plan");
    // 真·祈使动作词仍命中
    expect(resolveEffectiveMode("auto", "add a logout button")).toBe("accept-edits");
  });

  it("auto + 危险词不自动升 full-auto(安全底线)", () => {
    const r = resolveEffectiveMode("auto", "修复后顺便 rm -rf /tmp/x");
    expect(r).not.toBe("full-auto");
  });

  it("空 prompt / 空白 → plan(安全默认)", () => {
    expect(resolveEffectiveMode("auto", "")).toBe("plan");
    expect(resolveEffectiveMode("auto", "   \n  ")).toBe("plan");
  });
});
