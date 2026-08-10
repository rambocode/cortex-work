// 文档抽取是所有主聊天运行形态的内置能力，不能只在长驻 Pi 会话可用。
//
// Pi 在启用自动子 Agent 后会从 gateway 长驻会话切到 cli:start 单发路径；两条路径的
// MCP server 收集代码彼此独立。若单发桥接漏掉 cortex-docs，会话仍能正常运行，但模型只会
// 静默回退到 bash / Python / pdftotext。该故障没有类型错误，也不会让进程失败，只能用一条
// 跨入口守卫保证 buildDocExtractMcpServerConfig 同时存在于两条装配链。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("文档抽取工具覆盖 Pi 的两种主聊天运行形态", () => {
  const piSession = read("../../ipc/pi-session.ts");
  const cli = read("../../ipc/cli.ts");
  const piOneShotStart = cli.indexOf("let piOneShot:");
  const piOneShotEnd = cli.indexOf("const inactivityMs", piOneShotStart);
  const piOneShotBlock = cli.slice(piOneShotStart, piOneShotEnd);

  it("gateway 长驻会话注入 cortex-docs", () => {
    expect(piSession).toContain("buildDocExtractMcpServerConfig(prepared.uiSessionId)");
  });

  it("cli:start 单发会话同样注入 cortex-docs", () => {
    expect(piOneShotStart).toBeGreaterThanOrEqual(0);
    expect(piOneShotEnd).toBeGreaterThan(piOneShotStart);
    expect(piOneShotBlock).toContain("buildDocExtractMcpServerConfig(req.sessionId)");
  });
});
