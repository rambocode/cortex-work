// Cortex vendored slides runtime 的产品化契约:运行 UI 不展示上游品牌,也不携带自更新入口。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const vendorFile = (relative: string): string =>
  readFileSync(join(REPO_ROOT, "vendor/bento", relative), "utf8");

describe("Cortex slides runtime 产品化契约", () => {
  it("编辑器顶部与启动 splash 不包含 Bento logo 或品牌 favicon", () => {
    const editor = vendorFile("src/editor/editor.ts");
    const index = vendorFile("index.html");
    expect(editor).not.toContain("class=\"ed-logo-mark\"");
    expect(editor).not.toContain("About Bento Slides");
    expect(index).not.toContain('rel="icon"');
    expect(index).not.toContain("bs-mark");
    expect(index).not.toContain("<b>Bento</b>/Slides");
  });

  it("runtime 不保留版本检测、发布服务器或脚本更新 API", () => {
    const editor = vendorFile("src/editor/editor.ts");
    const main = vendorFile("src/main.ts");
    expect(editor).not.toContain("checkForUpdates");
    expect(editor).not.toContain("APP_VERSION");
    expect(main).not.toContain("checkForUpdates");
    expect(main).not.toContain("updates:");
    expect(existsSync(join(REPO_ROOT, "vendor/bento/src/update.ts"))).toBe(false);
  });

  it("页面标题和文件类型名称不追加上游品牌", () => {
    const runtimeSources = [
      vendorFile("src/main.ts"),
      vendorFile("src/save.ts"),
      vendorFile("src/cortex/present-modes.ts"),
    ].join("\n");
    expect(runtimeSources).not.toContain("— Bento Slides");
    expect(vendorFile("src/save.ts")).not.toContain("description: 'Bento Slides'");
  });

  it("runtime 内容标识覆盖 splash 等壳内容,不仅是 JS/CSS", () => {
    const root = mkdtempSync(join(tmpdir(), "cortex-runtime-id-"));
    const buildInput = (splashLabel: string): string =>
      '<!doctype html><html><head><title>演示文稿</title><style>.app{color:red}</style>' +
      '<script type="application/bento+json" id="bento-doc"></script></head><body>' +
      `<div id="bento-splash"><div>${splashLabel}</div></div><div id="app"></div>` +
      '<script type="module">window.runtimeBoot=true</script></body></html>';
    try {
      const first = join(root, "first.html");
      const second = join(root, "second.html");
      writeFileSync(first, buildInput("loading-a"));
      writeFileSync(second, buildInput("loading-b"));
      const script = join(REPO_ROOT, "vendor/bento/scripts/postbuild-compress.mjs");
      execFileSync(process.execPath, [script, first]);
      execFileSync(process.execPath, [script, second]);
      const id = (path: string): string =>
        /<meta name="cortex-slides-runtime" content="([^"]+)"/.exec(readFileSync(path, "utf8"))?.[1] ?? "";
      expect(id(first)).not.toBe("");
      expect(id(second)).not.toBe("");
      expect(id(first)).not.toBe(id(second));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
