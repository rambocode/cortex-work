// readMarketplaceIndex 单测：异构 schema 归一 + 坏条目容错 + 文件缺失/非法 JSON。
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMarketplaceIndex } from "./marketplace";

let base: string;
const prev = process.env.CORTEX_AGENTS_PLUGINS_ROOT;

function writeIndex(content: string): void {
  writeFileSync(join(base, "marketplace.json"), content);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "plugin-market-"));
  process.env.CORTEX_AGENTS_PLUGINS_ROOT = base;
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  if (prev === undefined) delete process.env.CORTEX_AGENTS_PLUGINS_ROOT;
  else process.env.CORTEX_AGENTS_PLUGINS_ROOT = prev;
});

describe("readMarketplaceIndex", () => {
  it("识别 local 源（source.path）", async () => {
    writeIndex(JSON.stringify({ plugins: [{ name: "cowart", source: { source: "local", path: "./plugins/cowart" }, category: "Productivity" }] }));
    const res = await readMarketplaceIndex();
    const e = res.items[0];
    expect(e.sourceKind).toBe("local");
    expect(e.sourcePath).toBe("./plugins/cowart");
    expect(e.ok).toBe(true);
  });

  it("识别 git 源（gitUrl）", async () => {
    writeIndex(JSON.stringify({ plugins: [{ id: "plugin-x", name: "Plugin X", gitUrl: "https://example.com/x.git", version: "1.0.0" }] }));
    const e = (await readMarketplaceIndex()).items[0];
    expect(e.sourceKind).toBe("git");
    expect(e.gitUrl).toBe("https://example.com/x.git");
    expect(e.ok).toBe(true);
  });

  it("缺 source/gitUrl 的坏条目 → ok=false + error（错误卡）", async () => {
    writeIndex(JSON.stringify({ plugins: [{ id: "broken", name: "Broken" }] }));
    const e = (await readMarketplaceIndex()).items[0];
    expect(e.ok).toBe(false);
    expect(e.error).toContain("source");
  });

  it("文件缺失 → 空列表 + rootExists=false", async () => {
    const res = await readMarketplaceIndex();
    expect(res).toEqual({ items: [], rootExists: false });
  });

  it("JSON 非法 → 空列表 + 顶层 error，不抛", async () => {
    writeIndex("{ not json");
    const res = await readMarketplaceIndex();
    expect(res.rootExists).toBe(true);
    expect(res.items).toEqual([]);
    expect(res.error).toContain("JSON");
  });

  it("缺 plugins 数组 → 顶层 error", async () => {
    writeIndex(JSON.stringify({ foo: 1 }));
    const res = await readMarketplaceIndex();
    expect(res.error).toContain("plugins");
  });
});
