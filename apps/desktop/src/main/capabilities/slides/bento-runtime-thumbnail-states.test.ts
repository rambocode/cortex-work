// Cortex slides 左侧缩略图的视觉层级契约:
// 当前页必须完整高亮;其他页主动降亮度/饱和度,不能只靠一圈细边框区分。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const styles = readFileSync(join(REPO_ROOT, "vendor/bento/src/styles.css"), "utf8");

describe("Cortex slides 缩略图选中状态", () => {
  it("未选中项降低亮度与饱和度,悬停时适度恢复", () => {
    expect(styles).toMatch(
      /\.ed-thumb:not\(\.active\)\s*\{[^}]*opacity:\s*0\.64;[^}]*filter:\s*brightness\(0\.86\)\s+saturate\(0\.72\);/s,
    );
    expect(styles).toMatch(
      /\.ed-thumb:not\(\.active\):hover\s*\{[^}]*opacity:\s*0\.86;[^}]*filter:\s*brightness\(0\.96\)\s+saturate\(0\.9\);/s,
    );
  });

  it("当前页恢复完整亮度并用外环与阴影强化高亮", () => {
    expect(styles).toMatch(
      /\.ed-thumb\.active\s*\{[^}]*opacity:\s*1;[^}]*filter:\s*none;[^}]*box-shadow:[^}]*color-mix\(in srgb,\s*var\(--accent\)\s*28%,\s*transparent\)[^}]*;/s,
    );
  });
});
