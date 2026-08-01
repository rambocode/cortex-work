// resolveExistingFile 单测:存在性口径 + 行号后缀(`file.md:53`)剥离回退。
import { describe, expect, it, vi } from "vitest";
import type { DesktopBridge } from "@cortex-work/core";
import { resolveExistingFile } from "./resolveFileRef";

// 只放行 real 集合内路径的 fileExists 桥替身。
function bridgeWith(real: string[]): DesktopBridge {
  return {
    fileExists: vi.fn(async (p: string) => real.includes(p)),
  } as unknown as DesktopBridge;
}

describe("resolveExistingFile 行号后缀回退", () => {
  const abs = "/Users/mike/source/ai/skills/incident/references/content-schema.md";

  it("绝对路径原样存在 → 直接返回", async () => {
    expect(await resolveExistingFile(bridgeWith([abs]), "", abs)).toBe(abs);
  });

  it("绝对路径带 :行号 → 原样落空后剥后缀命中,返回剥掉后缀的真实路径", async () => {
    expect(await resolveExistingFile(bridgeWith([abs]), "", `${abs}:53`)).toBe(abs);
  });

  it("绝对路径带 :行:列 → 连续数字段一并剥掉", async () => {
    expect(await resolveExistingFile(bridgeWith([abs]), "", `${abs}:53:7`)).toBe(abs);
  });

  it("剥掉后缀仍不存在 → null(不误点亮)", async () => {
    expect(await resolveExistingFile(bridgeWith([]), "", `${abs}:53`)).toBeNull();
  });

  it("真名含 :数字 的文件以原样命中优先,不剥后缀", async () => {
    const weird = "/tmp/backup:2026.md";
    expect(await resolveExistingFile(bridgeWith([weird]), "", weird)).toBe(weird);
  });

  it("相对路径带 :行号 → 拼项目根 + 剥后缀命中", async () => {
    const root = "/code/alpha";
    const target = "/code/alpha/docs/a.md";
    expect(await resolveExistingFile(bridgeWith([target]), root, "docs/a.md:12")).toBe(target);
  });
});
