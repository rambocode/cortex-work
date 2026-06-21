import { describe, it, expect } from "vitest";
import { buildErrorPageScript } from "./browserErrorPage";

const params = {
  title: "无法访问此站点",
  reason: "localhost:3000 拒绝建立连接",
  hints: ["检查网络", "dev server 是否启动"],
  codeLabel: "错误码",
  code: "ERR_CONNECTION_REFUSED",
  reloadLabel: "重新加载",
  openLabel: "在系统浏览器打开",
  url: "http://localhost:3000/",
};

describe("buildErrorPageScript", () => {
  it("产出语法合法的 JS(可被 new Function 解析,不抛)", () => {
    const script = buildErrorPageScript(params);
    expect(() => new Function(script)).not.toThrow();
  });

  it("内嵌水母 SVG 与动画 keyframes", () => {
    const script = buildErrorPageScript(params);
    expect(script).toContain("cx-bell");
    expect(script).toContain("cxBob");
    expect(script).not.toContain("\\u25C9"); // 旧的紫色圆点已移除
  });

  it("恶意 url 经 JSON.stringify 注入,不破坏脚本语法", () => {
    const script = buildErrorPageScript({ ...params, url: `http://x/"});alert(1);//` });
    expect(() => new Function(script)).not.toThrow();
  });
});
