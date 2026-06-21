import { describe, it, expect } from "vitest";
import { describeBrowserError } from "./browserErrorInfo";

describe("describeBrowserError", () => {
  it("DNS 解析失败给 dns 原因 + 检查网址", () => {
    const info = describeBrowserError(-105);
    expect(info.reasonKey).toBe("error.reason.dns");
    expect(info.hintKeys).toContain("error.hint.checkUrl");
  });

  it("连接被拒(公网)给通用 refused", () => {
    const info = describeBrowserError(-102, "example.com");
    expect(info.reasonKey).toBe("error.reason.refused");
  });

  it("连接被拒(环回)给 dev-server 专属建议", () => {
    const info = describeBrowserError(-102, "127.0.0.1:5173");
    expect(info.reasonKey).toBe("error.reason.refusedDev");
    expect(info.hintKeys).toContain("error.hint.devServer");
  });

  it("连接被拒(localhost / 私网)同样走 dev-server 建议", () => {
    expect(describeBrowserError(-102, "localhost:3000").reasonKey).toBe("error.reason.refusedDev");
    expect(describeBrowserError(-102, "192.168.1.10:8080").reasonKey).toBe("error.reason.refusedDev");
  });

  it("超时(-7 / -118)给 timeout", () => {
    expect(describeBrowserError(-7).reasonKey).toBe("error.reason.timeout");
    expect(describeBrowserError(-118).reasonKey).toBe("error.reason.timeout");
  });

  it("断网给 offline", () => {
    expect(describeBrowserError(-106).reasonKey).toBe("error.reason.offline");
  });

  it("证书错误(-200/-201/-202)给 cert", () => {
    expect(describeBrowserError(-200).reasonKey).toBe("error.reason.cert");
    expect(describeBrowserError(-202).reasonKey).toBe("error.reason.cert");
  });

  it("未知错误码给 unknown 兜底", () => {
    const info = describeBrowserError(-9999);
    expect(info.reasonKey).toBe("error.reason.unknown");
    expect(info.hintKeys.length).toBeGreaterThan(0);
  });
});
