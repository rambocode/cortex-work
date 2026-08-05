// 灰度开关单测。核心断言只有一条:**默认必须是二进制路径**——迁移期任何一次「默认值飘了」
// 都等于把全体用户一次性切到未验证的新引擎上。

import { afterEach, describe, expect, it } from "vitest";

import {
  __resetPiFeatureFlagForTests,
  __setPiInProcEnabledForTests,
  isPiInProcEnabled,
  parseBoolFlag,
  PI_INPROC_ENV_FLAG,
  resolvePiEngineChoice,
  setPiInProcEnabled,
} from "./feature-flag";

afterEach(() => __resetPiFeatureFlagForTests());

describe("resolvePiEngineChoice", () => {
  it("缺省走二进制路径(R3:默认关)", () => {
    expect(resolvePiEngineChoice({})).toEqual({ engine: "binary", source: "default" });
    expect(isPiInProcEnabled({})).toBe(false);
  });

  it("环境变量可开启", () => {
    expect(resolvePiEngineChoice({ [PI_INPROC_ENV_FLAG]: "1" })).toEqual({ engine: "inproc", source: "env" });
    expect(resolvePiEngineChoice({ [PI_INPROC_ENV_FLAG]: "true" }).engine).toBe("inproc");
    expect(resolvePiEngineChoice({ [PI_INPROC_ENV_FLAG]: "0" })).toEqual({ engine: "binary", source: "env" });
  });

  it("无法识别的环境变量取值当作未设置(拼写错误不该静默吞掉开启意图)", () => {
    expect(resolvePiEngineChoice({ [PI_INPROC_ENV_FLAG]: "maybe" })).toEqual({ engine: "binary", source: "default" });
  });

  it("运行时覆盖优先于环境变量;传 null 交还给环境变量", () => {
    const env = { [PI_INPROC_ENV_FLAG]: "0" };
    setPiInProcEnabled(true);
    expect(resolvePiEngineChoice(env)).toEqual({ engine: "inproc", source: "override" });
    setPiInProcEnabled(null);
    expect(resolvePiEngineChoice(env).source).toBe("env");
  });

  it("测试注入优先级最高", () => {
    setPiInProcEnabled(false);
    __setPiInProcEnabledForTests(true);
    expect(resolvePiEngineChoice({ [PI_INPROC_ENV_FLAG]: "0" })).toEqual({ engine: "inproc", source: "test" });
  });
});

describe("parseBoolFlag", () => {
  it("三态解析", () => {
    expect(parseBoolFlag(undefined)).toBeUndefined();
    expect(parseBoolFlag("")).toBeUndefined();
    expect(parseBoolFlag(" YES ")).toBe(true);
    expect(parseBoolFlag("Off")).toBe(false);
  });
});
