// 注入点守卫（读源码断言，手法同 reply/helper-build-script.test.ts）。
//
// 自动化与日历的写工具**只能**在 pi RPC 聊天路径注入 —— 那是全仓唯一存在真审批回路的地方：
//   · claude 在 full-auto 下走 --dangerously-skip-permissions（agents/claude.ts），全放行；
//   · codex 的内置 server 被强制 default_tools_approval_mode="approve"（ipc/mcp-config.ts）；
//   · pi 单发路径不写审批 extension，且 extension 里的 ctx.hasUI 为 false。
// 一旦有人「顺手」把这两个 server 并进 cli.ts 的 builtinServers 或 piBridgeCfgs，
// 「用户确认才生效」这条承诺就在那些路径上无声失效 —— 不报错、不崩溃，只是不再问。
//
// 这类跨文件的架构约束没有类型系统能表达，只能靠一条测试守住。
// 本仓对「漏改/误改注入点」有前科（cli.ts 里 knowledge server 的 TODO 就是活证据）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const BUILDERS = ["buildAutomationMcpServerConfig", "buildCalendarMcpServerConfig"];

describe("自动化 / 日历的注入点只有 pi RPC 一处", () => {
  const piSession = read("../../ipc/pi-session.ts");
  const cli = read("../../ipc/cli.ts");
  const runner = read("../../automation/runner.ts");

  it.each(BUILDERS)("%s 在 pi-session.ts 里被调用", (fn) => {
    expect(piSession).toContain(fn);
  });

  it.each(BUILDERS)("%s **不得**出现在 cli.ts（claude/codex 与 pi 单发路径无审批回路）", (fn) => {
    expect(cli).not.toContain(fn);
  });

  it.each(BUILDERS)("%s **不得**出现在 automation/runner.ts（无人值守路径）", (fn) => {
    expect(runner).not.toContain(fn);
  });

  it("两个 server 的 session 映射由统一 disposal 路径清理，pi:close 与 killAllPiSessions 都复用该路径", () => {
    for (const fn of ["unregisterAutomationSession", "unregisterCalendarSession"]) {
      // unregister 收敛到一个 helper 后，不再用重复调用次数代表覆盖面；直接钉住 helper 的职责。
      expect(piSession).toMatch(new RegExp(`function cleanupPiCapabilitySessions[\\s\\S]*?${fn}\\(uiSessionId\\)`));
    }
    // 显式 close、应用退出和崩溃/重开都经 disposeSessionEntry；该函数必须调用统一 helper。
    expect(piSession).toMatch(/function disposeSessionEntry[\s\S]*?cleanupPiCapabilitySessions\(uiSessionId\)/);
    expect(piSession).toMatch(/ipcMain\.handle\("pi:close"[\s\S]*?disposeSessionEntry\(uiSessionId, entry, true\)/);
    expect(piSession).toMatch(/function killAllPiSessions[\s\S]*?disposeSessionEntry\(uiSessionId, entry, true\)/);
  });

  it("日历的 allowWrite 在 pi RPC 路径为 true", () => {
    expect(piSession).toMatch(/buildCalendarMcpServerConfig\(\s*prepared\.uiSessionId,\s*true\s*\)/);
  });
});
