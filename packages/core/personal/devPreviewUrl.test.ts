import { describe, it, expect } from "vitest";
import {
  isAllowedDevPreviewHostname,
  isAllowedDevPreviewUrl,
  isLoopbackDevPreviewUrl,
  isLoopbackOnly,
  normalizeDevPreviewUrlInput,
} from "./devPreviewUrl";

describe("normalizeDevPreviewUrlInput", () => {
  it("纯端口号补成 127.0.0.1", () => {
    expect(normalizeDevPreviewUrlInput("5173")).toBe("http://127.0.0.1:5173/");
  });

  it("缺 scheme 的 localhost 补 http 并补根路径", () => {
    expect(normalizeDevPreviewUrlInput("localhost:5173")).toBe("http://localhost:5173/");
  });

  it("0.0.0.0 监听地址归一为 127.0.0.1", () => {
    expect(normalizeDevPreviewUrlInput("http://0.0.0.0:3000")).toBe("http://127.0.0.1:3000/");
  });

  it("私网地址放行(card 用)", () => {
    expect(normalizeDevPreviewUrlInput("http://192.168.1.10:3000")).toBe(
      "http://192.168.1.10:3000/",
    );
  });

  it("公网地址拒绝", () => {
    expect(normalizeDevPreviewUrlInput("http://8.8.8.8:3000")).toBeNull();
    expect(normalizeDevPreviewUrlInput("https://example.com")).toBeNull();
  });

  it("非 http(s) scheme 拒绝", () => {
    expect(normalizeDevPreviewUrlInput("ftp://localhost:21")).toBeNull();
    expect(normalizeDevPreviewUrlInput("javascript:alert(1)")).toBeNull();
  });

  it("空输入返回 null", () => {
    expect(normalizeDevPreviewUrlInput("   ")).toBeNull();
  });
});

describe("isAllowedDevPreviewHostname(card 全集)", () => {
  it("放行本地/私网/.local/docker", () => {
    for (const h of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.0.1",
      "169.254.169.254",
      "host.docker.internal",
      "foo.local",
      "::1",
    ]) {
      expect(isAllowedDevPreviewHostname(h)).toBe(true);
    }
  });

  it("拒绝公网", () => {
    expect(isAllowedDevPreviewHostname("example.com")).toBe(false);
    expect(isAllowedDevPreviewHostname("8.8.8.8")).toBe(false);
    expect(isAllowedDevPreviewHostname("172.15.0.1")).toBe(false); // 172.16-31 之外
  });
});

describe("isLoopbackOnly(auto_open 收紧集)", () => {
  it("仅放行环回", () => {
    expect(isLoopbackOnly("127.0.0.1")).toBe(true);
    expect(isLoopbackOnly("localhost")).toBe(true);
    expect(isLoopbackOnly("::1")).toBe(true);
  });

  it("剔除私网/169.254/docker(防 SSRF)", () => {
    expect(isLoopbackOnly("192.168.1.10")).toBe(false);
    expect(isLoopbackOnly("10.0.0.1")).toBe(false);
    expect(isLoopbackOnly("169.254.169.254")).toBe(false);
    expect(isLoopbackOnly("host.docker.internal")).toBe(false);
  });
});

describe("isLoopbackDevPreviewUrl", () => {
  it("环回 URL 为真", () => {
    expect(isLoopbackDevPreviewUrl("http://127.0.0.1:5173")).toBe(true);
    expect(isLoopbackDevPreviewUrl("localhost:5173")).toBe(true);
  });
  it("私网 URL 为假", () => {
    expect(isLoopbackDevPreviewUrl("http://192.168.1.10:3000")).toBe(false);
    expect(isLoopbackDevPreviewUrl("http://169.254.169.254/")).toBe(false);
  });
});

describe("isAllowedDevPreviewUrl", () => {
  it("等价于 normalize 非空", () => {
    expect(isAllowedDevPreviewUrl("localhost:5173")).toBe(true);
    expect(isAllowedDevPreviewUrl("https://example.com")).toBe(false);
  });
});
