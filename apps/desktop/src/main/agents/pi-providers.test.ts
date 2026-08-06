// pi-providers.ts 存留纯函数（safeId）的单测。
// binary 引擎删除后，provider extension 的渲染/落盘链路（renderPiExtension / writePiExtension /
// buildPiProviderConfig 等）连同其用例一并移除——「内建绝不下发 models、自定义完整下发」等
// 不变量由 providers/pi-inproc-models.ts（原生 ModelRuntime 注册表）及其测试承担。
import { describe, expect, it } from "vitest";

import { safeId } from "./pi-providers";

describe("safeId", () => {
  it("大写/空格/特殊字符 → 合法 slug；全非法字符回退 provider", () => {
    expect(safeId("My Custom LLM!")).toBe("my-custom-llm");
    expect(safeId("深度求索")).toBe("provider");
  });

  it("前后缀连字符收敛，幂等（注册名与查询键必须同源）", () => {
    expect(safeId("  -Anthropic-  ")).toBe("anthropic");
    expect(safeId(safeId("My Custom LLM!"))).toBe("my-custom-llm");
  });
});
