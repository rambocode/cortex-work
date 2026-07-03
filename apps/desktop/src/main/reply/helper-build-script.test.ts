import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("Cortex_Helper 构建脚本命名", () => {
  it("package scripts 使用 Cortex_Helper 品牌名，不再暴露 build:reply-helper", () => {
    const pkg = JSON.parse(readFileSync(`${desktopRoot}package.json`, "utf8")) as {
      scripts: Record<string, string>;
    };
    const scriptText = JSON.stringify(pkg.scripts);

    expect(pkg.scripts["build:cortex-helper"]).toBe("node scripts/build-cortex-helper.mjs");
    expect(pkg.scripts["build:reply-helper"]).toBeUndefined();
    expect(scriptText).not.toContain("build:reply-helper");
    expect(scriptText).not.toContain("build-reply-helper.mjs");
  });

  it("构建入口文件也使用 Cortex_Helper 品牌名", () => {
    expect(existsSync(`${desktopRoot}scripts/build-cortex-helper.mjs`)).toBe(true);
    expect(existsSync(`${desktopRoot}scripts/build-reply-helper.mjs`)).toBe(false);
  });
});
