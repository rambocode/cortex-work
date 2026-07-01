import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDef } from "./index";
import type { CliStartRequest } from "../ipc/types";

// mock ../log:桩化 createLogger 以断言 parseLineEvents 的「未映射帧」盲区补点;
// 避免加载真 electron-log/main(读 electron app)。工厂经 vi.hoisted 注入 vi.fn。
// isDevEnv 默认 true(dev);个别用例用 mockReturnValue(false) 验证 prod 不落。
const logMocks = vi.hoisted(() => ({ debug: vi.fn(), isDev: vi.fn(() => true) }));
vi.mock("../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), verbose: vi.fn(), debug: logMocks.debug, silly: vi.fn() }),
  isDevEnv: () => logMocks.isDev(),
}));

import {
  baseAgentKindOf,
  getAgentDef,
  listAgentProfiles,
  parseLineEvents,
  refreshLocalAgentProfiles,
  setLocalAgentProfilesLoader,
} from "./index";

const req = { agent: "claude", prompt: "hi", cwd: "/tmp", runId: "r", sessionId: "s" } as CliStartRequest;

afterEach(() => setLocalAgentProfilesLoader(null)); // 恢复默认 loader + 清缓存

describe("getAgentDef 内置", () => {
  it("返回内置 def", () => {
    setLocalAgentProfilesLoader(() => []);
    expect(getAgentDef("claude").id).toBe("claude");
    expect(getAgentDef("codex").id).toBe("codex");
    expect(getAgentDef("pi").id).toBe("pi");
  });

  it("未知 agent 抛错", () => {
    setLocalAgentProfilesLoader(() => []);
    expect(() => getAgentDef("nope")).toThrow(/未知 agent/);
  });
});

describe("getAgentDef 派生(M3-A)", () => {
  it("新 id 可解析,沿用 base 能力位 + 覆盖 bin/args", () => {
    setLocalAgentProfilesLoader(() => [
      { id: "my-codex", base: "codex", bin: "/opt/codex", extraArgs: ["--sandbox", "off"] },
    ]);
    const def = getAgentDef("my-codex");
    expect(def.id).toBe("my-codex");
    expect(def.mcpInjection).toBe("codex-c"); // 沿用 codex 能力位
    const built = def.buildArgs(req);
    expect(built.cmd).toBe("/opt/codex");
    expect(built.args.slice(-2)).toEqual(["--sandbox", "off"]);
  });

  it("覆盖内置同名 id → getAgentDef 返回派生版", () => {
    setLocalAgentProfilesLoader(() => [{ id: "claude", base: "claude", bin: "/custom/claude" }]);
    expect(getAgentDef("claude").buildArgs(req).cmd).toBe("/custom/claude");
  });

  it("base 非内置的条目被防御性跳过(不应出现,parse 已拦)", () => {
    // @ts-expect-error 故意构造非法 base 验证防御
    setLocalAgentProfilesLoader(() => [{ id: "x", base: "ghost" }]);
    expect(() => getAgentDef("x")).toThrow(/未知 agent/);
  });
});

describe("listAgentProfiles", () => {
  it("列出派生元数据(含覆盖内置的)", () => {
    setLocalAgentProfilesLoader(() => [
      { id: "my-claude", base: "claude", label: "My Claude" },
      { id: "codex", base: "codex" },
    ]);
    expect(listAgentProfiles()).toEqual([
      { id: "my-claude", base: "claude", label: "My Claude" },
      { id: "codex", base: "codex", label: undefined },
    ]);
  });

  it("无派生 → []", () => {
    setLocalAgentProfilesLoader(() => []);
    expect(listAgentProfiles()).toEqual([]);
  });
});

describe("baseAgentKindOf", () => {
  it("内置 → 自身", () => {
    setLocalAgentProfilesLoader(() => []);
    expect(baseAgentKindOf("claude")).toBe("claude");
    expect(baseAgentKindOf("codex")).toBe("codex");
    expect(baseAgentKindOf("pi")).toBe("pi");
  });
  it("派生新 id → 其 base", () => {
    setLocalAgentProfilesLoader(() => [{ id: "my-codex", base: "codex" }]);
    expect(baseAgentKindOf("my-codex")).toBe("codex");
  });
  it("未知 id → 兜底 claude", () => {
    setLocalAgentProfilesLoader(() => []);
    expect(baseAgentKindOf("ghost")).toBe("claude");
  });
});

describe("refreshLocalAgentProfiles", () => {
  it("失效缓存后重新读取 loader", () => {
    let profiles = [{ id: "v1", base: "claude" as const }];
    setLocalAgentProfilesLoader(() => profiles);
    expect(listAgentProfiles().map((p) => p.id)).toEqual(["v1"]);
    profiles = [{ id: "v2", base: "claude" as const }];
    // 未刷新 → 命中缓存
    expect(listAgentProfiles().map((p) => p.id)).toEqual(["v1"]);
    refreshLocalAgentProfiles();
    expect(listAgentProfiles().map((p) => p.id)).toEqual(["v2"]);
  });
});

describe("parseLineEvents 盲区补点(U4)", () => {
  // 极简 fake def:parseLine 可控返回单事件 / 数组 / null,验证三态归一 + 空结果落日志。
  function fakeDef(parseLine: AgentDef["parseLine"]): AgentDef {
    return { id: "fake", parseLine } as unknown as AgentDef;
  }

  beforeEach(() => {
    logMocks.debug.mockReset();
    logMocks.isDev.mockReturnValue(true);
  });

  it("未映射的 JSON 帧(解析空且以 { 开头)→ 记录一条 debug(含脱敏原始帧)", () => {
    const def = fakeDef(() => null);
    expect(parseLineEvents(def, '{"type":"weird","token":"abc123"}')).toEqual([]);
    expect(logMocks.debug).toHaveBeenCalledTimes(1);
    const [msg, line] = logMocks.debug.mock.calls[0]!;
    expect(msg).toContain("未映射");
    expect(line).not.toContain("abc123"); // redactString 脱敏后落盘
  });

  it("正常被忽略的非 JSON 行(纯文本/ping)→ 不刷屏(只对 { 开头的疑似帧告警)", () => {
    const def = fakeDef(() => null);
    expect(parseLineEvents(def, "some plain assistant text")).toEqual([]);
    expect(parseLineEvents(def, "   ")).toEqual([]);
    expect(logMocks.debug).not.toHaveBeenCalled();
  });

  it("prod(非 dev)不落未映射帧日志", () => {
    logMocks.isDev.mockReturnValue(false);
    const def = fakeDef(() => null);
    expect(parseLineEvents(def, '{"type":"weird"}')).toEqual([]);
    expect(logMocks.debug).not.toHaveBeenCalled();
  });

  it("命中 def.ignoredFrameTypes 的帧 → 即使解析空、以 { 开头,也不告警(已评审的故意忽略,非盲区)", () => {
    const def = {
      ...fakeDef(() => null),
      ignoredFrameTypes: new Set(["turn_end", "agent_end"]),
    };
    expect(parseLineEvents(def, '{"type":"turn_end","message":{}}')).toEqual([]);
    expect(parseLineEvents(def, '{"type":"agent_end","willRetry":false}')).toEqual([]);
    expect(logMocks.debug).not.toHaveBeenCalled();
    // 未在忽略集合里的 type 仍正常告警,不会被这个位"一刀切"消音。
    expect(parseLineEvents(def, '{"type":"totally_new_frame"}')).toEqual([]);
    expect(logMocks.debug).toHaveBeenCalledTimes(1);
  });

  it("解析出事件(单/数组)→ 不落日志,返回行为不变", () => {
    const single = fakeDef(() => ({ type: "text", delta: "a" }) as never);
    expect(parseLineEvents(single, "ok")).toEqual([{ type: "text", delta: "a" }]);
    const arr = fakeDef(() => [{ type: "text", delta: "a" }, { type: "result", ok: true }] as never);
    expect(parseLineEvents(arr, "ok")).toHaveLength(2);
    expect(logMocks.debug).not.toHaveBeenCalled();
  });
});

describe("transport 能力位(U1)", () => {
  it("仅 codex 标 ws,claude/pi 缺省(spawn)", () => {
    setLocalAgentProfilesLoader(() => []);
    expect(getAgentDef("codex").transport).toBe("ws");
    expect(getAgentDef("claude").transport).toBeUndefined();
    expect(getAgentDef("pi").transport).toBeUndefined();
  });

  it("分流判定 (transport ?? spawn):仅 codex 走 ws", () => {
    setLocalAgentProfilesLoader(() => []);
    const isWs = (id: string) => (getAgentDef(id).transport ?? "spawn") === "ws";
    expect(isWs("codex")).toBe(true);
    expect(isWs("claude")).toBe(false);
    expect(isWs("pi")).toBe(false);
  });

  it("派生 base:codex 继承 transport:ws,profile.bin 同步到 serverCmd", () => {
    setLocalAgentProfilesLoader(() => [{ id: "my-codex", base: "codex", bin: "/opt/custom-codex" }]);
    const def = getAgentDef("my-codex");
    expect(def.transport).toBe("ws"); // 继承
    expect(def.serverCmd).toBe("/opt/custom-codex"); // ws 路径用自定义 bin(RISK-7)
  });

  it("派生 base:claude 不引入 ws", () => {
    setLocalAgentProfilesLoader(() => [{ id: "my-claude", base: "claude" }]);
    expect(getAgentDef("my-claude").transport).toBeUndefined();
  });
});
