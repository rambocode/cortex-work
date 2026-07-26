import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const source = readFileSync(
  join(REPO_ROOT, "vendor/bento/src/cortex/host-bridge.ts"),
  "utf8",
);

describe("Bento 当前页宿主桥", () => {
  it("空元素选区也回传页面 payload，而不是丢成 null", () => {
    expect(source).toContain("items: elements.map");
    expect(source).not.toMatch(/if\s*\(\s*!elements\.length\s*\)\s*\{[\s\S]*?selectionChanged\(null\)/);
  });

  it("暴露即时推送入口，供晚注入的宿主完成首次握手", () => {
    expect(source).toContain("__cortexPushDeckContext = push");
  });
});
