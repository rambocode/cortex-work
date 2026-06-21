import { afterEach, describe, expect, it } from "vitest";
import type { CliStartRequest } from "../ipc/types";
import {
  baseAgentKindOf,
  getAgentDef,
  listAgentProfiles,
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
