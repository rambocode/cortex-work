// 包加载层单测。真 ESM 包不在这里加载（重，且 pi-coding-agent 顶层带全局副作用），
// 只验证「缓存 / 失败不缓存 / 响亮报错 / 预热吞错」四条策略，外加 KTD1、KTD2 的源码级守卫。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

const logMocks = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() },
}));
vi.mock("../../log", () => ({ createLogger: () => logMocks.logger, isDevEnv: () => true }));

import {
  __resetPiRuntimeCacheForTests,
  __setPiRuntimeImporterForTests,
  loadPiAgentCore,
  loadPiAiCompat,
  loadPiCodingAgent,
  PiRuntimeLoadError,
  primePiInProcRuntime,
} from "./runtime";

afterEach(() => {
  __resetPiRuntimeCacheForTests();
  logMocks.logger.warn.mockClear();
  logMocks.logger.error.mockClear();
});

describe("包加载", () => {
  it("三个 loader 各按包名 import,specifier 是拼出来的完整包名", async () => {
    const seen: string[] = [];
    __setPiRuntimeImporterForTests(async (s) => {
      seen.push(s);
      return { spec: s };
    });
    await loadPiCodingAgent();
    await loadPiAgentCore();
    await loadPiAiCompat();
    expect(seen).toEqual([
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai/compat",
    ]);
  });

  it("成功结果被缓存(并发首次加载也只 import 一次)", async () => {
    const importer = vi.fn(async () => ({ ok: true }));
    __setPiRuntimeImporterForTests(importer);
    const [a, b] = await Promise.all([loadPiCodingAgent(), loadPiCodingAgent()]);
    await loadPiCodingAgent();
    expect(importer).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("失败**不**缓存:装包问题修好后无需重启即可恢复", async () => {
    let fail = true;
    const importer = vi.fn(async () => {
      if (fail) throw new Error("ERR_MODULE_NOT_FOUND");
      return { ok: true };
    });
    __setPiRuntimeImporterForTests(importer);

    await expect(loadPiCodingAgent()).rejects.toBeInstanceOf(PiRuntimeLoadError);
    fail = false;
    await expect(loadPiCodingAgent()).resolves.toMatchObject({ ok: true });
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it("失败响亮:包名 + 原始错误一并抛出并落日志(绝不静默降级)", async () => {
    __setPiRuntimeImporterForTests(async () => {
      throw new Error("Cannot find package");
    });
    const err = await loadPiCodingAgent().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PiRuntimeLoadError);
    expect((err as PiRuntimeLoadError).pkg).toBe("pi-coding-agent");
    expect((err as Error).message).toContain("pi-coding-agent");
    expect((err as Error).message).toContain("Cannot find package");
    expect(logMocks.logger.error).toHaveBeenCalled();
  });

  it("预热失败不抛(不影响应用启动),但记 warn", async () => {
    __setPiRuntimeImporterForTests(async () => {
      throw new Error("boom");
    });
    await expect(primePiInProcRuntime()).resolves.toBeUndefined();
    expect(logMocks.logger.warn).toHaveBeenCalled();
  });
});

describe("KTD1 / KTD2 源码级守卫", () => {
  // 这两条只能靠读源码守：写成字符串字面量 specifier 会让 rollup 把整张纯 ESM 依赖图打进 CJS
  // chunk（历史上 ERR_MODULE_NOT_FOUND 的根因）；top-level await 则让 CJS 构建直接失败。
  // 两者都不会在单测/运行时暴露，只会在打包产物里出问题。
  const src = readFileSync(fileURLToPath(new URL("./runtime.ts", import.meta.url)), "utf8");
  // 注释里会**举例**说明被禁写法（那正是文件头长注释在做的事），不剥掉就会自己把自己判红。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("specifier 全部由数组 join 拼出，且动态 import 带 @vite-ignore", () => {
    expect(src).toContain('["@earendil-works", "pi-coding-agent"].join("/")');
    expect(src).toContain('["@earendil-works", "pi-agent-core"].join("/")');
    expect(src).toContain('["@earendil-works", "pi-ai", "compat"].join("/")');
    expect(src).toContain("/* @vite-ignore */");
  });

  it("没有以字符串字面量为 specifier 的**运行时** import", () => {
    // `typeof import("...")` 与 `import type` 都只出现在类型位置、编译期擦除，不构成打包边，
    // 故排除在外；被禁的只有会真正生成 require/import 调用的那种写法。
    expect(/(?<!typeof\s)import\(\s*["'`]@earendil-works/.test(code)).toBe(false);
    expect(/^import\s+(?!type\b)[^;]*from\s+["'`]@earendil-works/m.test(code)).toBe(false);
  });

  it("没有 top-level await（KTD2）", () => {
    expect(/^await\s/m.test(code)).toBe(false);
    expect(/^(const|let|var)\s+\w+\s*=\s*await\s/m.test(code)).toBe(false);
  });
});
