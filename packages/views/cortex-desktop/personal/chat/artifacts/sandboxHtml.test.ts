// 沙箱纯逻辑单测。jsdom 不执行 iframe 脚本,真执行靠端到端手动冒烟;这里锁 srcdoc 结构、
// 转义、CSP 与消息协议校验——它们是安全模型的可测一半。

import { describe, expect, it } from "vitest";

import { buildSandboxSrcdoc, escapeScriptContent, parsePiSandboxMessage, PI_SANDBOX_MSG } from "./sandboxHtml";

describe("buildSandboxSrcdoc", () => {
  it("html 模式:runtime + CSP 注入 <head> 内,产物本体原样保留", () => {
    const doc = buildSandboxSrcdoc({
      mode: "html",
      code: "<!DOCTYPE html><html><head><title>t</title></head><body><h1>hi</h1></body></html>",
      sandboxId: "sb1",
    });
    const headAt = doc.indexOf("<head>");
    expect(doc.indexOf("Content-Security-Policy")).toBeGreaterThan(headAt);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf("<title>"));
    expect(doc).toContain("<h1>hi</h1>");
    expect(doc).toContain('"sb1"');
  });

  it("html 模式:无 head/html 标签时整体前置(三级回退)", () => {
    const doc = buildSandboxSrcdoc({ mode: "html", code: "<div>裸片段</div>", sandboxId: "sb2" });
    expect(doc.startsWith("<meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(doc.endsWith("<div>裸片段</div>")).toBe(true);
  });

  it("CSP:默认放行 https;allowNetwork:false 时 connect-src 'none' 且无 https:", () => {
    const open = buildSandboxSrcdoc({ mode: "html", code: "<div/>", sandboxId: "s" });
    expect(open).toContain("connect-src https:");
    const closed = buildSandboxSrcdoc({ mode: "html", code: "<div/>", sandboxId: "s", allowNetwork: false });
    expect(closed).toContain("connect-src 'none'");
    expect(closed).not.toContain("script-src 'unsafe-inline' https:");
  });

  it("repl 模式:用户代码套 async 包壳,</script> 被转义防提前闭合", () => {
    const doc = buildSandboxSrcdoc({ mode: "repl", code: 'console.log("</script><img>")', sandboxId: "sb3" });
    expect(doc).toContain("__PI_SANDBOX_ID");
    // 用户代码里的 </script> 必须被转义(否则闭合包壳标签,后续内容成裸 HTML 注入面)。
    expect(doc).toContain("<\\/script><img>");
  });

  it("escapeScriptContent 大小写不敏感(统一替换为小写转义形态,语义不变)", () => {
    expect(escapeScriptContent("</SCRIPT></script>")).toBe("<\\/script><\\/script>");
  });
});

describe("parsePiSandboxMessage(宿主侧协议校验单点)", () => {
  const ok = (extra: Record<string, unknown>) => ({ type: PI_SANDBOX_MSG, sandboxId: "sb", ...extra });

  it("sandboxId 不符 / 类型标记不符 / 畸形一律拒绝", () => {
    expect(parsePiSandboxMessage(ok({ kind: "done", ok: true }), "别的id")).toBeNull();
    expect(parsePiSandboxMessage({ type: "其它", sandboxId: "sb", kind: "done" }, "sb")).toBeNull();
    expect(parsePiSandboxMessage(null, "sb")).toBeNull();
    expect(parsePiSandboxMessage("字符串", "sb")).toBeNull();
    expect(parsePiSandboxMessage(ok({ kind: "未知" }), "sb")).toBeNull();
  });

  it("console/error/done 帧归一;非法 level 回退 log", () => {
    expect(parsePiSandboxMessage(ok({ kind: "console", entry: { level: "诡异", text: "x" } }), "sb")).toEqual({
      kind: "console",
      entry: { level: "log", text: "x" },
    });
    expect(parsePiSandboxMessage(ok({ kind: "error", message: "boom", stack: "st" }), "sb")).toEqual({
      kind: "error",
      message: "boom",
      stack: "st",
    });
    expect(parsePiSandboxMessage(ok({ kind: "done", ok: true, returnValue: "42" }), "sb")).toEqual({
      kind: "done",
      ok: true,
      returnValue: "42",
    });
  });

  it("open-external 只认 http(s),file:/javascript: 协议拒绝", () => {
    expect(parsePiSandboxMessage(ok({ kind: "open-external", url: "https://a.com" }), "sb")).toEqual({
      kind: "open-external",
      url: "https://a.com",
    });
    expect(parsePiSandboxMessage(ok({ kind: "open-external", url: "file:///etc/passwd" }), "sb")).toBeNull();
    // eslint-disable-next-line no-script-url
    expect(parsePiSandboxMessage(ok({ kind: "open-external", url: "javascript:alert(1)" }), "sb")).toBeNull();
  });
});
