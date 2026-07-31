// Provider Catalog 单测（阶段①·2.1）：分两层——
//   A. 生成层：直接调 scripts/build-pi-catalog.mjs 的 buildProviderCatalog()，
//      断言锁定版本 pi 的关键能力字段被逐字保留、radius 被排除。
//      刻意不跑 bun 编译（那是 pi 二进制的事），本层是纯 JS 计算，秒级。
//   B. 加载层：用 __fixtures__/provider-catalog.json 拼出临时的「随包 pi 目录」，
//      验证正常加载与四类失败（缺文件 / schema 不认 / hash 不符 / 版本不一致）
//      都返回结构化错误而非抛异常——调用方必须能降级。

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// catalog.ts 经 pi-locate 间接依赖 electron，node 环境下必须先 mock。
vi.mock("electron", () => ({
  app: { isPackaged: false, getAppPath: () => "/fake/apps/desktop" },
}));

import { loadProviderCatalogAt } from "./catalog";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "__fixtures__/provider-catalog.json");
const FIXTURE_PI_VERSION = "0.82.1";

/** 拼一个临时的「随包 pi 目录」：catalog + 旁置的 pi package.json（版本来源）。 */
function makePiDir(options: { catalog?: string; piVersion?: string | null } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cortex-catalog-"));
  if (options.catalog !== undefined) writeFileSync(join(dir, "provider-catalog.json"), options.catalog);
  if (options.piVersion !== null) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: options.piVersion ?? FIXTURE_PI_VERSION }));
  }
  return dir;
}

const tmpDirs: string[] = [];
const track = (dir: string) => {
  tmpDirs.push(dir);
  return dir;
};

let fixtureJson: string;

beforeEach(() => {
  fixtureJson = readFileSync(FIXTURE, "utf-8");
});

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── A. 生成层 ────────────────────────────────────────────────────────────────

describe("buildProviderCatalog（锁定 pi 版本的生成结果）", () => {
  // 动态 import：脚本是 .mjs，且首次 import 会加载整个 pi-ai provider 表，放在用例里按需加载。
  const load = async () =>
    (await import("../../../scripts/build-pi-catalog.mjs")) as unknown as {
      buildProviderCatalog: () => Promise<{
        catalog: {
          schemaVersion: number;
          piVersion: string;
          hash: string;
          providers: {
            id: string;
            auth: string[];
            envVars?: string[];
            models: Record<string, unknown>[];
          }[];
        };
        skipped: string[];
      }>;
    };

  it("保留 pi 内置目录的原始能力字段（本次事故的核心回归）", async () => {
    const { buildProviderCatalog } = await load();
    const { catalog } = await buildProviderCatalog();

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.piVersion).toBe(FIXTURE_PI_VERSION);

    const openai = catalog.providers.find((p) => p.id === "openai");
    const gpt4o = openai?.models.find((m) => m.id === "gpt-4o");
    // 多模态 + 128k 上下文：被 Cortex 旧映射覆盖成 text/131072 正是图片被吞的直接原因。
    expect(gpt4o).toMatchObject({
      api: "openai-responses",
      input: ["text", "image"],
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 16384,
    });

    const o3mini = openai?.models.find((m) => m.id === "o3-mini");
    expect(o3mini).toMatchObject({ reasoning: true, input: ["text"], contextWindow: 200000 });
    // thinkingLevelMap / compat 是 Cortex 完全未建模的字段，必须原样带过而不是被丢弃。
    expect(o3mini?.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(o3mini?.compat).toEqual({ supportsStrictMode: true });
  });

  it("排除零静态模型的纯动态 Provider（radius）", async () => {
    const { buildProviderCatalog } = await load();
    const { catalog, skipped } = await buildProviderCatalog();
    expect(skipped).toContain("radius");
    expect(catalog.providers.map((p) => p.id)).not.toContain("radius");
    expect(catalog.providers.every((p) => p.models.length > 0)).toBe(true);
  });

  it("认证方式与环境变量派生自 pi 定义本身", async () => {
    const { buildProviderCatalog } = await load();
    const { catalog } = await buildProviderCatalog();

    expect(catalog.providers.find((p) => p.id === "openai")?.auth).toEqual(["api-key"]);
    expect(catalog.providers.find((p) => p.id === "openai")?.envVars).toEqual(["OPENAI_API_KEY"]);
    // openai-codex 只有 OAuth（无 apiKey 分支），不应凭空补出 api-key。
    expect(catalog.providers.find((p) => p.id === "openai-codex")?.auth).toEqual(["oauth"]);
    expect(catalog.providers.find((p) => p.id === "anthropic")?.auth).toEqual(["api-key", "oauth"]);
    // bedrock 的 ambient 来源（AWS profile / IAM）由探测得到，不是手写表。
    expect(catalog.providers.find((p) => p.id === "amazon-bedrock")?.envVars).toContain("AWS_PROFILE");
  });

  it("同版本重复生成结果稳定（hash 可复现）", async () => {
    const { buildProviderCatalog } = await load();
    const [a, b] = [await buildProviderCatalog(), await buildProviderCatalog()];
    expect(a.catalog.hash).toBe(b.catalog.hash);
    expect(JSON.stringify(a.catalog)).toBe(JSON.stringify(b.catalog));
  });
});

// ── B. 加载层 ────────────────────────────────────────────────────────────────

describe("loadProviderCatalogAt", () => {
  it("校验通过时返回冻结的只读 Catalog", () => {
    const dir = track(makePiDir({ catalog: fixtureJson }));
    const result = loadProviderCatalogAt(dir);

    expect(result.ok).toBe(true);
    expect(result.catalog?.providers.map((p) => p.id)).toEqual(["anthropic", "openai", "openai-codex"]);

    // 能力对 Cortex 只读：任何就地改写都不得生效（严格模式下会抛，这里用非严格断言值未变）。
    const model = result.catalog!.providers[1].models[0];
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.input)).toBe(true);
  });

  it("文件缺失 → 结构化错误而非抛异常", () => {
    const dir = track(makePiDir());
    const result = loadProviderCatalogAt(dir);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("无法读取 Provider 目录");
  });

  it("schemaVersion 不受支持 → 结构化错误", () => {
    const bumped = { ...JSON.parse(fixtureJson), schemaVersion: 2 };
    const dir = track(makePiDir({ catalog: JSON.stringify(bumped) }));
    const result = loadProviderCatalogAt(dir);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("schemaVersion");
  });

  it("内容被改动但 hash 未更新 → 结构化错误（防止能力被就地篡改）", () => {
    const tampered = JSON.parse(fixtureJson);
    tampered.providers[1].models[0].input = ["text"]; // 把 gpt-4o 降级成纯文本
    const dir = track(makePiDir({ catalog: JSON.stringify(tampered) }));
    const result = loadProviderCatalogAt(dir);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("hash 不符");
  });

  it("Catalog 与随包 pi 版本不一致 → 结构化错误", () => {
    const dir = track(makePiDir({ catalog: fixtureJson, piVersion: "0.83.0" }));
    const result = loadProviderCatalogAt(dir);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("版本不一致");
  });

  it("读不到随包 pi 版本 → 拒绝使用（无法证明同版本就不上线）", () => {
    const dir = track(makePiDir({ catalog: fixtureJson, piVersion: null }));
    const result = loadProviderCatalogAt(dir);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("无法确认随包 pi 版本");
  });

  it("JSON 结构非法 → 结构化错误", () => {
    const dir = track(makePiDir({ catalog: '{"schemaVersion":1}' }));
    const result = loadProviderCatalogAt(dir);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("结构非法");
  });
});
