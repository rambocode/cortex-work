import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDef } from "./index";
import type { CliStartRequest } from "../ipc/types";

// mock ../log:桩化 createLogger 以断言 parseLineEvents 的「无法识别行」盲区补点;
// 避免加载真 electron-log/main(读 electron app)。工厂经 vi.hoisted 注入 vi.fn。
const logMocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../log", () => ({
  createLogger: () => ({ error: vi.fn(), warn: logMocks.warn, info: vi.fn(), verbose: vi.fn(), debug: vi.fn(), silly: vi.fn() }),
  isDevEnv: () => true,
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

  beforeEach(() => logMocks.warn.mockReset());

  it("无法识别行(解析空)→ 记录一条 parse 警告(含脱敏后的原始行)", () => {
    const def = fakeDef(() => null);
    expect(parseLineEvents(def, 'x token=abc123 y')).toEqual([]);
    expect(logMocks.warn).toHaveBeenCalledTimes(1);
    const [msg, line] = logMocks.warn.mock.calls[0]!;
    expect(msg).toContain("无法识别");
    expect(line).toBe("x token=*** y"); // redactString 脱敏后落盘
  });

  it("空白行不落日志(正常分帧产物,免噪声)", () => {
    const def = fakeDef(() => null);
    expect(parseLineEvents(def, "   ")).toEqual([]);
    expect(logMocks.warn).not.toHaveBeenCalled();
  });

  it("解析出事件(单/数组)→ 不落日志,返回行为不变", () => {
    const single = fakeDef(() => ({ type: "text", delta: "a" }) as never);
    expect(parseLineEvents(single, "ok")).toEqual([{ type: "text", delta: "a" }]);
    const arr = fakeDef(() => [{ type: "text", delta: "a" }, { type: "result", ok: true }] as never);
    expect(parseLineEvents(arr, "ok")).toHaveLength(2);
    expect(logMocks.warn).not.toHaveBeenCalled();
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
