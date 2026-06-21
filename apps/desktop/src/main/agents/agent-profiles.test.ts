import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveAgentDef,
  parseLocalAgentProfiles,
  readLocalAgentProfilesFile,
  type LocalAgentProfile,
} from "./agent-profiles";
import type { AgentDef } from "./index";

// 最小假 base def,隔离派生逻辑(不依赖真实 claude/codex)。buildArgs 回显 mcpArgs 以验证转发。
function fakeBase(over: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "claude",
    promptDelivery: "stdin-stream-json",
    mcpInjection: "claude-mcp-json",
    sessionResume: "continue+resume",
    imageDelivery: "prompt-text",
    appendSystemPrompt: "native-flag",
    buildArgs(_req, mcpArgs) {
      return { cmd: "claude", args: ["-p", ...(mcpArgs ?? [])], stdin: "PAYLOAD" };
    },
    parseLine: () => null,
    ...over,
  };
}

describe("parseLocalAgentProfiles", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("接受 { agents: [...] } 形态并归一合法项", () => {
    const out = parseLocalAgentProfiles({
      agents: [
        { id: "my-claude", base: "claude", label: "My", bin: "/x/claude", extraArgs: ["--model", "m"], env: { A: "1" } },
      ],
    });
    expect(out).toEqual([
      { id: "my-claude", base: "claude", label: "My", bin: "/x/claude", extraArgs: ["--model", "m"], env: { A: "1" } },
    ]);
  });

  it("也接受顶层数组(宽松写法)", () => {
    const out = parseLocalAgentProfiles([{ id: "codex", base: "codex" }]);
    expect(out).toEqual([{ id: "codex", base: "codex" }]);
  });

  it("跳过非法项、保留合法项", () => {
    const out = parseLocalAgentProfiles({
      agents: [
        { id: "ok", base: "claude" },
        { id: "Bad ID", base: "claude" }, // 非法 id(空格/大写)
        { id: "no-base", base: "nope" }, // base 非内置
        { id: "bad-env", base: "claude", env: { X: 1 } }, // env 值非字符串
        { id: "bad-args", base: "claude", extraArgs: ["ok", 2] }, // 数组含非字符串
        { id: "empty-bin", base: "claude", bin: "  " }, // 空 bin
        42, // 非对象
      ],
    });
    expect(out.map((p) => p.id)).toEqual(["ok"]);
  });

  it("按 id 去重,保留首个", () => {
    const out = parseLocalAgentProfiles({
      agents: [
        { id: "dup", base: "claude", label: "first" },
        { id: "dup", base: "codex", label: "second" },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("first");
  });

  it("非数组/空输入返回 []", () => {
    expect(parseLocalAgentProfiles(null)).toEqual([]);
    expect(parseLocalAgentProfiles({})).toEqual([]);
    expect(parseLocalAgentProfiles({ agents: "x" })).toEqual([]);
  });
});

describe("readLocalAgentProfilesFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-profiles-"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("文件不存在 → []", () => {
    expect(readLocalAgentProfilesFile(join(dir, "nope.json"))).toEqual([]);
  });

  it("非法 JSON → [](不抛错)", () => {
    const p = join(dir, "agents.local.json");
    writeFileSync(p, "{ not json", "utf8");
    expect(readLocalAgentProfilesFile(p)).toEqual([]);
  });

  it("合法文件 → 解析", () => {
    const p = join(dir, "agents.local.json");
    writeFileSync(p, JSON.stringify({ agents: [{ id: "my-x", base: "codex" }] }), "utf8");
    expect(readLocalAgentProfilesFile(p)).toEqual([{ id: "my-x", base: "codex" }]);
  });
});

describe("deriveAgentDef", () => {
  const req = {} as Parameters<AgentDef["buildArgs"]>[0];

  it("bin 覆盖 cmd,其余沿用 base", () => {
    const def = deriveAgentDef(fakeBase(), { id: "my-claude", base: "claude", bin: "/opt/claude" });
    const built = def.buildArgs(req);
    expect(built.cmd).toBe("/opt/claude");
    expect(built.stdin).toBe("PAYLOAD");
    expect(def.id).toBe("my-claude");
    expect(def.mcpInjection).toBe("claude-mcp-json"); // 能力位沿用 base
  });

  it("不填 bin → 沿用 base cmd", () => {
    const def = deriveAgentDef(fakeBase(), { id: "x", base: "claude" });
    expect(def.buildArgs(req).cmd).toBe("claude");
  });

  it("extraArgs 追加到 base args 末尾", () => {
    const def = deriveAgentDef(fakeBase(), { id: "x", base: "claude", extraArgs: ["--foo", "bar"] });
    expect(def.buildArgs(req).args).toEqual(["-p", "--foo", "bar"]);
  });

  it("转发 mcpArgs 给 base.buildArgs", () => {
    const def = deriveAgentDef(fakeBase(), { id: "x", base: "claude", extraArgs: ["--foo"] });
    expect(def.buildArgs(req, ["-c", "k=v"]).args).toEqual(["-p", "-c", "k=v", "--foo"]);
  });

  it("env → extraEnv(与 base.extraEnv 合并,profile 优先)", () => {
    const def = deriveAgentDef(fakeBase({ extraEnv: { A: "base", B: "base" } }), {
      id: "x",
      base: "claude",
      env: { B: "prof", C: "prof" },
    } as LocalAgentProfile);
    expect(def.extraEnv).toEqual({ A: "base", B: "prof", C: "prof" });
  });

  it("无 env 且 base 无 extraEnv → extraEnv 为 undefined", () => {
    const def = deriveAgentDef(fakeBase(), { id: "x", base: "claude" });
    expect(def.extraEnv).toBeUndefined();
  });

  it("parseLine 沿用 base", () => {
    const base = fakeBase({ parseLine: () => ({ type: "init", sessionId: "s1" }) });
    const def = deriveAgentDef(base, { id: "x", base: "claude" });
    expect(def.parseLine("anything")).toEqual({ type: "init", sessionId: "s1" });
  });
});
