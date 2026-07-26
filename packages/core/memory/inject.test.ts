// 记忆注入组装测试：拼装顺序、注释剥离、预算截断、开关门控。
import { beforeEach, describe, expect, it } from "vitest";
import { buildMemoryAppend, composeMemoryAppend } from "./inject";
import { emptyUserMemoryState } from "./memory";
import { useMemoryStore } from "../store/memory";
import { usePersonalStore } from "../store/personal";

function stateWith(partial: Parameters<typeof composeMemoryAppend>[0] extends infer T ? Partial<T> : never) {
  return { ...emptyUserMemoryState(), ...partial };
}

describe("composeMemoryAppend 纯组装", () => {
  it("全空记忆返回 undefined", () => {
    expect(composeMemoryAppend(emptyUserMemoryState())).toBeUndefined();
  });

  it("按分区顺序拼装，手写在前自动在后，HTML 注释被剥离", () => {
    const out = composeMemoryAppend(
      stateWith({
        profile: { manual: "<!-- 引导 -->\n我是前端工程师", auto: "- 在做 cortex", research: "" },
        projects: { manual: "", auto: "- 项目 X 进行中", research: "" },
      }),
    );
    expect(out).toBeDefined();
    expect(out).toContain("【用户画像】\n手写补充：\n我是前端工程师\n自动整理：\n- 在做 cortex");
    expect(out).toContain("【项目背景】\n自动整理：\n- 项目 X 进行中");
    expect(out).not.toContain("<!--");
    // 画像分区在项目分区之前（优先级顺序）
    expect(out!.indexOf("【用户画像】")).toBeLessThan(out!.indexOf("【项目背景】"));
  });

  it("超预算时后位分区整段弃、首个分区例外保留", () => {
    const big = "很长的内容".repeat(60); // 单段远超预算
    const out = composeMemoryAppend(
      stateWith({
        profile: { manual: big, auto: "", research: "" },
        preferences: { manual: "短偏好", auto: "", research: "" },
      }),
      100,
    );
    // 首个分区超预算仍保留；后续分区被弃
    expect(out).toContain("【用户画像】");
    expect(out).not.toContain("【偏好习惯】");
  });
});

describe("buildMemoryAppend 读 store + 开关门控", () => {
  beforeEach(() => {
    useMemoryStore.getState().hydrateMemory(
      stateWith({ profile: { manual: "我是 Mike", auto: "", research: "" } }),
    );
  });

  it("缺省（memoryEnabled 未设置）视为开启", () => {
    usePersonalStore.setState((s) => ({
      generalSettings: { ...s.generalSettings, memoryEnabled: undefined },
    }));
    expect(buildMemoryAppend()).toContain("我是 Mike");
  });

  it("显式关闭时返回 undefined", () => {
    usePersonalStore.setState((s) => ({
      generalSettings: { ...s.generalSettings, memoryEnabled: false },
    }));
    expect(buildMemoryAppend()).toBeUndefined();
    // 复位，避免污染其它测试
    usePersonalStore.setState((s) => ({
      generalSettings: { ...s.generalSettings, memoryEnabled: undefined },
    }));
  });
});
