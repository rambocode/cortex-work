import { describe, it, expect } from "vitest";
import {
  resolveHotkeyRegistration,
  isValidAccelerator,
  resolveRebind,
  rebindCandidates,
  resolveRebindChain,
  NOTES_HOTKEY_OCCUPIED_TOAST,
  NOTES_HOTKEY_INVALID_TOAST,
  NOTES_HOTKEY_UNAVAILABLE_TOAST,
  NOTES_HOTKEY_ACCELERATOR,
  TASKS_HOTKEY_ACCELERATOR,
} from "./hotkey";

describe("resolveHotkeyRegistration", () => {
  it("ok=true → 注册成功、无降级、无提示", () => {
    const r = resolveHotkeyRegistration(true);
    expect(r.registered).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.toast).toBeUndefined();
  });

  it("ok=false → 注册失败、降级、带占用提示文案", () => {
    const r = resolveHotkeyRegistration(false);
    expect(r.registered).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.toast).toBe(NOTES_HOTKEY_OCCUPIED_TOAST);
  });

  it("默认键位为 CommandOrControl+Shift+N", () => {
    expect(NOTES_HOTKEY_ACCELERATOR).toBe("CommandOrControl+Shift+N");
  });
});

describe("isValidAccelerator", () => {
  it("正例:至少 1 个修饰键 + 恰好 1 个主键", () => {
    expect(isValidAccelerator("CommandOrControl+Shift+N")).toBe(true);
    expect(isValidAccelerator("Cmd+Alt+Space")).toBe(true);
    expect(isValidAccelerator("Control+Shift+F5")).toBe(true);
    expect(isValidAccelerator("Super+1")).toBe(true);
    expect(isValidAccelerator("Option+Tab")).toBe(true);
    expect(isValidAccelerator("Ctrl+Alt+Delete")).toBe(true);
    expect(isValidAccelerator("Meta+`")).toBe(true);
  });

  it("默认键位本身合法", () => {
    expect(isValidAccelerator(NOTES_HOTKEY_ACCELERATOR)).toBe(true);
  });

  it("大小写不敏感(修饰键与功能键名)", () => {
    expect(isValidAccelerator("cmd+shift+n")).toBe(true);
    expect(isValidAccelerator("control+shift+f12")).toBe(true);
  });

  it("反例:空串", () => {
    expect(isValidAccelerator("")).toBe(false);
    expect(isValidAccelerator("   ")).toBe(false);
  });

  it("反例:无修饰裸键(会拦截普通打字)", () => {
    expect(isValidAccelerator("N")).toBe(false);
    expect(isValidAccelerator("Space")).toBe(false);
    expect(isValidAccelerator("F5")).toBe(false);
  });

  it("反例:纯修饰键无主键", () => {
    expect(isValidAccelerator("Shift")).toBe(false);
    expect(isValidAccelerator("Cmd+Shift")).toBe(false);
    expect(isValidAccelerator("CommandOrControl+Alt")).toBe(false);
  });

  it("反例:残缺(尾随 +、空段)", () => {
    expect(isValidAccelerator("Cmd+")).toBe(false);
    expect(isValidAccelerator("+N")).toBe(false);
    expect(isValidAccelerator("Cmd++N")).toBe(false);
  });

  it("反例:多个主键", () => {
    expect(isValidAccelerator("Cmd+N+M")).toBe(false);
    expect(isValidAccelerator("Ctrl+A+B")).toBe(false);
  });

  it("反例:未知主键/乱码", () => {
    expect(isValidAccelerator("abc")).toBe(false);
    expect(isValidAccelerator("Cmd+abc")).toBe(false);
    expect(isValidAccelerator("Cmd+Foo")).toBe(false);
  });
});

describe("resolveRebind 占用时回退旧键", () => {
  it("新键格式无效 → 不重绑,降级提示格式无效", () => {
    const r = resolveRebind("Cmd+Shift+N", "abc", true);
    expect(r.registered).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.activeAccelerator).toBe("Cmd+Shift+N");
    expect(r.toast).toBeDefined();
  });

  it("新键合法且注册成功 → 切换到新键,无降级", () => {
    const r = resolveRebind("Cmd+Shift+N", "Cmd+Alt+Space", true);
    expect(r.registered).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.activeAccelerator).toBe("Cmd+Alt+Space");
  });

  it("新键合法但被占用 → 保持旧键绑定,降级提示占用", () => {
    const r = resolveRebind("Cmd+Shift+N", "Cmd+Alt+Space", false);
    expect(r.registered).toBe(false);
    expect(r.degraded).toBe(true);
    // 占用时回退旧键,保证始终有一个可用绑定。
    expect(r.activeAccelerator).toBe("Cmd+Shift+N");
    expect(r.toast).toBe(NOTES_HOTKEY_OCCUPIED_TOAST);
  });
});

describe("rebindCandidates 三级兜底候选链(去重、跳过非法、保持优先序)", () => {
  it("新键、旧键、默认键三者各异 → 依次列出三个候选", () => {
    expect(rebindCandidates("Cmd+Alt+Space", "Cmd+Shift+N")).toEqual([
      "Cmd+Alt+Space",
      "Cmd+Shift+N",
      NOTES_HOTKEY_ACCELERATOR,
    ]);
  });

  it("旧键等于默认键 → 去重,只剩新键 + 默认键", () => {
    expect(rebindCandidates("Cmd+Alt+Space", NOTES_HOTKEY_ACCELERATOR)).toEqual([
      "Cmd+Alt+Space",
      NOTES_HOTKEY_ACCELERATOR,
    ]);
  });

  it("新键等于默认键 → 去重,只剩默认键 + 旧键", () => {
    expect(rebindCandidates(NOTES_HOTKEY_ACCELERATOR, "Cmd+Alt+Space")).toEqual([
      NOTES_HOTKEY_ACCELERATOR,
      "Cmd+Alt+Space",
    ]);
  });

  it("旧键为空(启动期/无绑定)→ 跳过,只剩新键 + 默认键", () => {
    expect(rebindCandidates("Cmd+Alt+Space", "")).toEqual(["Cmd+Alt+Space", NOTES_HOTKEY_ACCELERATOR]);
  });

  it("旧键非法 → 跳过", () => {
    expect(rebindCandidates("Cmd+Alt+Space", "abc")).toEqual(["Cmd+Alt+Space", NOTES_HOTKEY_ACCELERATOR]);
  });

  it("三者全等 → 只剩一个候选", () => {
    expect(rebindCandidates(NOTES_HOTKEY_ACCELERATOR, NOTES_HOTKEY_ACCELERATOR)).toEqual([
      NOTES_HOTKEY_ACCELERATOR,
    ]);
  });

  it("任务捕获传自定义 defaultAcc → 末级兜底是任务键，绝不降级成闪记键（研究 rank11）", () => {
    const cands = rebindCandidates("Cmd+Alt+Space", "", TASKS_HOTKEY_ACCELERATOR);
    expect(cands).toEqual(["Cmd+Alt+Space", TASKS_HOTKEY_ACCELERATOR]);
    expect(cands).not.toContain(NOTES_HOTKEY_ACCELERATOR);
    expect(TASKS_HOTKEY_ACCELERATOR).not.toBe(NOTES_HOTKEY_ACCELERATOR);
  });
});

describe("resolveRebindChain 据候选链注册结果决策最终态", () => {
  const candidates = ["Cmd+Alt+Space", "Cmd+Shift+N", NOTES_HOTKEY_ACCELERATOR];

  it("新键格式无效 → 不重绑,降级提示格式无效,保持旧键", () => {
    const r = resolveRebindChain("Cmd+Shift+N", "abc", candidates, -1);
    expect(r.registered).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.toast).toBe(NOTES_HOTKEY_INVALID_TOAST);
    expect(r.activeAccelerator).toBe("Cmd+Shift+N");
  });

  it("第 0 个候选(新键)注册成功 → 切到新键,无降级", () => {
    const r = resolveRebindChain("Cmd+Shift+N", "Cmd+Alt+Space", candidates, 0);
    expect(r.registered).toBe(true);
    expect(r.degraded).toBe(false);
    expect(r.activeAccelerator).toBe("Cmd+Alt+Space");
    expect(r.toast).toBeUndefined();
  });

  it("新键失败、回退旧键成功 → 降级提示占用,active=旧键", () => {
    const r = resolveRebindChain("Cmd+Shift+N", "Cmd+Alt+Space", candidates, 1);
    expect(r.registered).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.toast).toBe(NOTES_HOTKEY_OCCUPIED_TOAST);
    expect(r.activeAccelerator).toBe("Cmd+Shift+N");
  });

  it("新键、旧键都失败、回退默认键成功 → 仍提示占用,active=默认键", () => {
    const r = resolveRebindChain("Cmd+Shift+N", "Cmd+Alt+Space", candidates, 2);
    expect(r.registered).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.toast).toBe(NOTES_HOTKEY_OCCUPIED_TOAST);
    expect(r.activeAccelerator).toBe(NOTES_HOTKEY_ACCELERATOR);
  });

  it("全部候选都失败(successIdx=-1)→ 无可用绑定,降级提示不可用,active 置空", () => {
    const r = resolveRebindChain("Cmd+Shift+N", "Cmd+Alt+Space", candidates, -1);
    expect(r.registered).toBe(false);
    expect(r.degraded).toBe(true);
    expect(r.toast).toBe(NOTES_HOTKEY_UNAVAILABLE_TOAST);
    expect(r.activeAccelerator).toBe("");
  });

  it("不可用提示常量文案明确", () => {
    expect(NOTES_HOTKEY_UNAVAILABLE_TOAST).toBe(
      "闪记热键当前不可用,请重新设置一个未被占用的快捷键",
    );
  });
});
