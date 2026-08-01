// 写作信息图生成(U7)单测:提示词构造(截断)、未配置降级、落盘与失败不写文件。
// 用真实临时目录跑真实 fs;electron 仅需 ipcMain 存根(handler 注册不在本测范围,直接调导出的纯业务函数)。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultMediaGenSettings } from "@cortex-work/core/desktop/types";
import type { MediaGenSettings } from "@cortex-work/core/desktop/types";

// 模块顶层 import electron:存根 ipcMain,使 import 不炸(本测直接调导出的纯业务函数)。
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

// resolve.ts 静态依赖金库模块(→ electron safeStorage):存根隔断依赖链。
// 本测走 custom+明文 apiKey 路径,resolve 不会真正读金库。
vi.mock("../providers/credentials", () => ({
  readSecrets: async () => ({}),
  readStoredCredential: async () => undefined,
}));

import {
  WRITING_INFOGRAPHIC_DEFAULT_PROMPT,
  WRITING_INFOGRAPHIC_MAX_TEXT_CHARS,
  buildWritingInfographicPrompt,
  buildInfographicImageName,
  isWritingInfographicConfigured,
  runWritingInfographic,
} from "./writing-infographic";

// 一份「已配置」的图片模态设置(providerId=custom,直接用自填字段;baseUrl 必须 https)。
function configuredMediaGen(): MediaGenSettings {
  const settings = defaultMediaGenSettings();
  settings.image = {
    ...settings.image,
    enabled: true,
    providerId: "custom",
    protocol: "openai-images",
    baseUrl: "https://api.example.com",
    apiKey: "sk-test",
    model: "gpt-image-1",
  };
  return settings;
}

describe("buildWritingInfographicPrompt", () => {
  it("默认前缀 + 空行 + 选中正文", () => {
    const out = buildWritingInfographicPrompt("  hello world  ");
    expect(out).toBe(`${WRITING_INFOGRAPHIC_DEFAULT_PROMPT}\n\nhello world`);
  });

  it("超长选区截断到 WRITING_INFOGRAPHIC_MAX_TEXT_CHARS", () => {
    const long = "x".repeat(WRITING_INFOGRAPHIC_MAX_TEXT_CHARS + 500);
    const out = buildWritingInfographicPrompt(long);
    const appended = out.slice(WRITING_INFOGRAPHIC_DEFAULT_PROMPT.length + 2); // 去掉前缀 + "\n\n"
    expect(appended.length).toBe(WRITING_INFOGRAPHIC_MAX_TEXT_CHARS);
  });
});

describe("isWritingInfographicConfigured", () => {
  it("enabled=false → false", async () => {
    const mg = configuredMediaGen();
    mg.image.enabled = false;
    expect(await isWritingInfographicConfigured(mg)).toBe(false);
  });

  it("完整配置 → true", async () => {
    expect(await isWritingInfographicConfigured(configuredMediaGen())).toBe(true);
  });

  it("缺 apiKey → false(resolve 抛错被吞成未配置)", async () => {
    const mg = configuredMediaGen();
    mg.image.apiKey = "";
    expect(await isWritingInfographicConfigured(mg)).toBe(false);
  });

  it("baseUrl 非 https → false(https 强校验)", async () => {
    const mg = configuredMediaGen();
    mg.image.baseUrl = "http://api.example.com";
    expect(await isWritingInfographicConfigured(mg)).toBe(false);
  });

  it("undefined 设置 → false", async () => {
    expect(await isWritingInfographicConfigured(undefined)).toBe(false);
  });
});

describe("buildInfographicImageName", () => {
  it("形如 infographic-<14位时间戳>-<hex>.png", () => {
    const name = buildInfographicImageName(new Date("2026-07-06T12:34:56.000Z"), "ab12");
    expect(name).toBe("infographic-20260706123456-ab12.png");
  });
});

describe("runWritingInfographic", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "writing-infographic-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("落盘到 <spaceRoot>/img/ 并返回绝对路径", async () => {
    const png = Buffer.from("PNG-BYTES");
    const res = await runWritingInfographic(
      { spaceRoot: root, text: "生成信息图的选区文字" },
      {
        loadState: async () => ({ mediaGenSettings: configuredMediaGen() }),
        assertAllowed: async () => {},
        generate: async () => png,
        now: () => new Date("2026-07-06T00:00:00.000Z"),
      },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.absolutePath).toBe(join(root, "img", res.fileName));
    expect(res.fileName).toMatch(/^infographic-\d{14}-[0-9a-f]+\.png$/);
    const written = await readFile(res.absolutePath);
    expect(written.equals(png)).toBe(true);
  });

  it("未配置 → 失败且不写文件", async () => {
    const mg = configuredMediaGen();
    mg.image.enabled = false;
    const generate = vi.fn();
    const res = await runWritingInfographic(
      { spaceRoot: root, text: "选区" },
      {
        loadState: async () => ({ mediaGenSettings: mg }),
        assertAllowed: async () => {},
        generate,
      },
    );
    expect(res.ok).toBe(false);
    expect(generate).not.toHaveBeenCalled();
    await expect(readdir(join(root, "img"))).rejects.toThrow(); // img 目录未创建
  });

  it("生成失败 → 失败且不写文件(先生成再落盘)", async () => {
    const res = await runWritingInfographic(
      { spaceRoot: root, text: "选区" },
      {
        loadState: async () => ({ mediaGenSettings: configuredMediaGen() }),
        assertAllowed: async () => {},
        generate: async () => {
          throw new Error("provider 500");
        },
      },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain("provider 500");
    await expect(readdir(join(root, "img"))).rejects.toThrow();
  });

  it("空选区 → 失败(不读设置、不生成)", async () => {
    const loadState = vi.fn();
    const res = await runWritingInfographic(
      { spaceRoot: root, text: "   " },
      { loadState, assertAllowed: async () => {} },
    );
    expect(res.ok).toBe(false);
    expect(loadState).not.toHaveBeenCalled();
  });

  it("assertAllowed 拒绝(空间越权)→ 失败且不写文件", async () => {
    const res = await runWritingInfographic(
      { spaceRoot: root, text: "选区" },
      {
        loadState: async () => ({ mediaGenSettings: configuredMediaGen() }),
        assertAllowed: async () => {
          throw new Error("路径越界");
        },
        generate: async () => Buffer.from("PNG"),
      },
    );
    expect(res.ok).toBe(false);
    await expect(readdir(join(root, "img"))).rejects.toThrow();
  });
});
