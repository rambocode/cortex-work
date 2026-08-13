// cortex-app:// 渲染端承载协议的路径解析单测:安全不变量是「解析结果永远锁在 root 之内」。
// handler 本体(protocol.handle/net.fetch)依赖真 electron 环境,不在单测范围。
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { rendererPageUrl, resolveRendererFile } from "./renderer-protocol";

const ROOT = join(sep, "app", "out", "renderer");

describe("resolveRendererFile", () => {
  it("常规页面与资产路径解析到 root 内对应文件", () => {
    expect(resolveRendererFile(ROOT, "cortex-app://renderer/index.html")).toBe(join(ROOT, "index.html"));
    expect(resolveRendererFile(ROOT, "cortex-app://renderer/assets/main-abc.js")).toBe(
      join(ROOT, "assets", "main-abc.js"),
    );
    // 空路径 / 根路径回落 index.html。
    expect(resolveRendererFile(ROOT, "cortex-app://renderer/")).toBe(join(ROOT, "index.html"));
  });

  it("目录穿越与 host 不符一律拒绝", () => {
    // 裸 ../ 在 URL 解析阶段就被折叠成 host 相对路径(浏览器同款行为),不构成穿越;
    // 真正的攻击面是**编码**穿越(%2e%2e/%2f),decodeURIComponent 后由 normalize+前缀校验拒绝。
    expect(resolveRendererFile(ROOT, "cortex-app://renderer/..%2f..%2fetc%2fpasswd")).toBeNull();
    // %2e%2e 在 URL 解析层就被解码并折叠(与浏览器一致),落点仍锁在 root 内(不存在则 404),无逃逸。
    expect(resolveRendererFile(ROOT, "cortex-app://renderer/%2e%2e/%2e%2e/etc/passwd")).toBe(
      join(ROOT, "etc", "passwd"),
    );
    expect(resolveRendererFile(ROOT, "cortex-app://evil/index.html")).toBeNull();
    expect(resolveRendererFile(ROOT, "not-a-url")).toBeNull();
  });

  it("rendererPageUrl 生成固定 host 的页面 URL", () => {
    expect(rendererPageUrl("index.html")).toBe("cortex-app://renderer/index.html");
  });
});
